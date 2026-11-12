const admin = require('firebase-admin');
const { sendEmail } = require('./email-service');

// ── Server-side HTML escaping ──────────────────────
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ── Rate limiting ──────────────────────────────────
const APPLY_RATE_MAX = 5;
const APPLY_RATE_WINDOW_MS = 3600000; // 1 hour
const applyRateMap = new Map();

function isApplyRateLimited(ip) {
    var now = Date.now();
    var entry = applyRateMap.get(ip);
    if (!entry || now - entry.windowStart > APPLY_RATE_WINDOW_MS) {
        applyRateMap.set(ip, { windowStart: now, count: 1 });
        return false;
    }
    entry.count++;
    return entry.count > APPLY_RATE_MAX;
}

exports.volunteerApply = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    // Rate limiting by IP
    var clientIp = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    if (typeof clientIp === 'string') clientIp = clientIp.split(',')[0].trim();
    if (isApplyRateLimited(clientIp)) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const { name, email, skills, interests, availability, position, portfolio } = req.body;

    // Validate required fields
    if (!name || !email || !skills || !skills.length || !availability) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email address' });
    }

    try {
        // Check for duplicate
        const existing = await admin.firestore().collection('volunteers')
            .where('email', '==', email.toLowerCase()).limit(1).get();
        if (!existing.empty) {
            return res.status(409).json({ error: 'An application with this email already exists' });
        }

        // Save to Firestore
        const docRef = await admin.firestore().collection('volunteers').add({
            name: name.trim(),
            email: email.toLowerCase().trim(),
            skills,
            interests: interests || [],
            availability,
            position: (typeof position === 'string' && position.trim()) ? position.trim().slice(0, 100) : null,
            portfolio: (typeof portfolio === 'string' && portfolio.trim()) ? portfolio.trim().slice(0, 500) : null,
            status: 'pending',
            appliedAt: admin.firestore.FieldValue.serverTimestamp(),
            onboardingSteps: {
                welcomeEmail: false,
                driveFolder: false,
                googleContact: false,
                chatInvite: false,
                calendarInvite: false
            },
            ndaSigned: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        // Send notification to officer (all user input HTML-escaped)
        try {
            const siteUrl = process.env.SITE_URL || 'https://scienceandfreedom.com';
            await sendEmail({
                // OFFICER_EMAIL is the sending mailbox; alerts go to the board group.
                to: process.env.VOLUNTEER_ALERT_EMAIL || 'board@scienceandfreedom.com',
                subject: (typeof position === 'string' && position.trim())
                    ? `New Application (${position.trim().slice(0, 100)}): ${name.trim()}`
                    : `New Volunteer Application: ${name.trim()}`,
                htmlBody: `
                    <h2>New Volunteer Application</h2>
                    ${(typeof position === 'string' && position.trim()) ? `<p><strong>Position:</strong> ${escapeHtml(position.trim().slice(0, 100))}</p>` : ''}
                    ${(typeof portfolio === 'string' && portfolio.trim()) ? `<p><strong>Portfolio:</strong> ${escapeHtml(portfolio.trim().slice(0, 500))}</p>` : ''}
                    <p><strong>Name:</strong> ${escapeHtml(name.trim())}</p>
                    <p><strong>Email:</strong> ${escapeHtml(email.trim())}</p>
                    <p><strong>Skills:</strong> ${escapeHtml(skills.join(', '))}</p>
                    <p><strong>Interests:</strong> ${escapeHtml((interests || []).join(', '))}</p>
                    <p><strong>Availability:</strong> ${escapeHtml(availability)}</p>
                    <hr>
                    <p><a href="${siteUrl}/admin">Review in Admin Panel</a></p>
                `
            });
        } catch (emailErr) {
            console.warn('Failed to send notification email (non-fatal):', emailErr.message);
        }

        return res.status(200).json({ success: true, id: docRef.id });
    } catch (e) {
        console.error('Volunteer apply error:', e);
        return res.status(500).json({ error: 'Failed to submit application' });
    }
};
