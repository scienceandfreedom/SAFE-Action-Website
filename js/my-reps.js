// ============================================
// SAFE Action - My Representatives Hub
// ============================================

const MyRepsHub = {
    _civicCache: null,
    _reps: [],
    _bills: [],
    STORAGE_KEY: 'safe_my_address',

    // ── Address Lookup ────────────────────────────

    async lookupAddress(address) {
        const apiKey = SAFE_CONFIG.GOOGLE_CIVIC_API_KEY;
        if (!apiKey) {
            console.warn('No Civic API key configured. Use state fallback.');
            return null;
        }

        // Use divisionsByAddress (representatives endpoint was retired April 2025)
        const url = `https://civicinfo.googleapis.com/civicinfo/v2/divisionsByAddress?address=${encodeURIComponent(address)}&key=${apiKey}`;
        try {
            const resp = await fetch(url);
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                throw new Error(err.error?.message || resp.statusText);
            }
            const data = await resp.json();
            this._civicCache = data;

            // Extract state and districts from OCD division IDs
            const parsed = this._parseDivisionsResponse(data);
            if (!parsed.state) {
                throw new Error('Could not determine state from address');
            }

            // Persist address and parsed divisions
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                address: address,
                timestamp: Date.now(),
                state: parsed.state,
                districts: parsed.districts,
                county: parsed.county,
                normalizedAddress: data.normalizedInput || {},
            }));

            // Use parsed divisions to load reps from seats.json
            return this._loadRepsFromDivisions(parsed);
        } catch (e) {
            console.error('Civic API error:', e);
            return null;
        }
    },

    getSavedAddress() {
        try {
            const stored = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
            if (stored && stored.address) {
                // Cache for 24 hours
                if (Date.now() - stored.timestamp < 24 * 60 * 60 * 1000) {
                    return stored;
                }
            }
        } catch (e) {}
        return null;
    },

    clearSavedAddress() {
        localStorage.removeItem(this.STORAGE_KEY);
    },

    _parseDivisionsResponse(data) {
        const divisions = data.divisions || {};
        const normalizedInput = data.normalizedInput || {};
        let state = '';
        const districts = [];
        // County-level division, for the county report card. A county, parish,
        // borough or census area wins over a place (independent city).
        let county = null;

        // Primary: use Google's normalizedInput.state - most reliable
        if (normalizedInput.state) {
            state = normalizedInput.state.toUpperCase();
        }

        for (const [ocdId, info] of Object.entries(divisions)) {
            // Fallback state extraction from OCD ID: ocd-division/country:us/state:wi
            // Only match "state:" (not "district:") to avoid DC's district:dc
            // matching against other OCD IDs
            if (!state) {
                const stateMatch = ocdId.match(/\/state:(\w{2})(?:\/|$)/i);
                if (stateMatch) {
                    state = stateMatch[1].toUpperCase();
                }
            }

            // County-level division: ocd-division/country:us/state:tx/county:travis
            const coMatch = ocdId.match(/\/state:\w{2}\/(county|parish|borough|census_area|place):([^/]+)$/i);
            if (coMatch) {
                const kind = coMatch[1].toLowerCase();
                if (!county || (county.kind === 'place' && kind !== 'place')) {
                    county = { kind: kind, name: coMatch[2] };
                }
            }

            // Extract congressional district: ocd-division/country:us/state:tx/cd:10
            const cdMatch = ocdId.match(/\/cd:(\S+)/i);
            if (cdMatch) {
                districts.push({
                    type: 'cd',
                    number: cdMatch[1],
                    name: info.name || '',
                    ocdId: ocdId,
                });
            }

            // Extract state legislative districts
            const sldlMatch = ocdId.match(/\/sldl:(\S+)/i);
            if (sldlMatch) {
                districts.push({
                    type: 'state-house',
                    number: sldlMatch[1],
                    name: info.name || '',
                    ocdId: ocdId,
                });
            }
            const slduMatch = ocdId.match(/\/sldu:(\S+)/i);
            if (slduMatch) {
                districts.push({
                    type: 'state-senate',
                    number: slduMatch[1],
                    name: info.name || '',
                    ocdId: ocdId,
                });
            }
        }

        // DC special case: ocd-division/country:us/district:dc
        if (!state) {
            for (const ocdId of Object.keys(divisions)) {
                const dcMatch = ocdId.match(/\/district:dc(?:\/|$)/i);
                if (dcMatch) { state = 'DC'; break; }
            }
        }

        return { state, districts, county };
    },

    // ── Census Geocoder Fallback ──────────────────
    // When Google Civic API doesn't return sldl/sldu, try Census Bureau

    async _censusDistrictLookup(normalizedAddress, originalAddress) {
        try {
            const { line1, city, state, zip } = normalizedAddress;

            // Strategy 1: Address-based Census lookup
            if (line1 && state) {
                const params = new URLSearchParams({
                    street: line1, city: city || '', state: state, zip: zip || '',
                });
                const resp = await fetch('/api/districts?' + params.toString());
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.found && data.districts && data.districts.length > 0) {
                        console.log('Census address lookup found districts:', data.districts);
                        return data.districts;
                    }
                }
            }

            // Strategy 2: Geocode via Nominatim (free), then coordinate-based Census lookup
            console.log('Census address lookup failed, trying Nominatim coordinate fallback...');
            const nomQueries = [];
            // Try full address first
            const fullAddr = originalAddress || [line1, city, state, zip].filter(Boolean).join(', ');
            if (fullAddr) nomQueries.push('q=' + encodeURIComponent(fullAddr));
            // Then try structured city/state/zip (more reliable for rural areas)
            if (city && state) nomQueries.push('city=' + encodeURIComponent(city) + '&state=' + encodeURIComponent(state) + (zip ? '&postalcode=' + encodeURIComponent(zip) : ''));

            for (const nomQ of nomQueries) {
                try {
                    const nomUrl = 'https://nominatim.openstreetmap.org/search?' + nomQ + '&format=json&limit=1&countrycodes=us';
                    const geoResp = await fetch(nomUrl);
                    if (geoResp.ok) {
                        const geoData = await geoResp.json();
                        const loc = geoData && geoData[0];
                        if (loc && loc.lat && loc.lon) {
                            console.log('Nominatim geocoded to:', loc.lat, loc.lon);
                            const coordParams = new URLSearchParams({ lat: loc.lat, lng: loc.lon });
                            const coordResp = await fetch('/api/districts?' + coordParams.toString());
                            if (coordResp.ok) {
                                const coordData = await coordResp.json();
                                if (coordData.found && coordData.districts && coordData.districts.length > 0) {
                                    console.log('Census coordinate lookup found districts:', coordData.districts);
                                    return coordData.districts;
                                }
                            }
                        }
                    }
                } catch (nomErr) {
                    console.warn('Nominatim attempt failed:', nomErr.message);
                }
            }

            return [];
        } catch (e) {
            console.warn('Census district lookup failed:', e.message);
            return [];
        }
    },

    async _loadRepsFromDivisions(parsed) {
        const { state, districts } = parsed;
        const cdNumbers = districts.filter(d => d.type === 'cd').map(d => d.number);

        // Load seats.json, legislators.json, and bills
        const [seatsData, legislatorsData, legislators, bills] = await Promise.all([
            fetch('data/seats.json').then(r => r.ok ? r.json() : { seats: [] }).catch(() => ({ seats: [] })),
            fetch('data/legislators.json').then(r => r.ok ? r.json() : { legislators: [] }).catch(() => ({ legislators: [] })),
            typeof IntelligenceAPI !== 'undefined' ? IntelligenceAPI.getLegislators(state).catch(() => []) : [],
            typeof LegislationAPI !== 'undefined' ? LegislationAPI.getLegislation(state).catch(() => []) : [],
        ]);
        const allLegislators = legislatorsData.legislators || [];

        // ── Federal reps from seats.json (have incumbents) ──
        const federalSeats = (seatsData.seats || []).filter(s => {
            if (s.state !== state) return false;
            if (!s.incumbent) return false;
            const bodyLower = s.body.toLowerCase();

            // US Senate: always include for the state
            if (s.body === 'US Senate') return true;
            // Governor: always include for the state
            if (s.body === 'Governor') return true;
            // US House: match by district number
            if (s.body === 'US House') {
                if (cdNumbers.length === 0) return true;
                const seatDistrict = String(s.district || '').replace(/^0+/, '');
                if (seatDistrict.toLowerCase() === 'at-large' || seatDistrict === '') return true;
                return cdNumbers.some(cd => {
                    const cdClean = String(cd).replace(/^0+/, '');
                    return cdClean === seatDistrict || cd === 'at-large';
                });
            }
            return false;
        });

        // ── State reps from legislators.json (full data with contact info) ──
        let stateHouseDistricts = districts.filter(d => d.type === 'state-house').map(d => d.number);
        let stateSenateDistricts = districts.filter(d => d.type === 'state-senate').map(d => d.number);

        // Census fallback: when Civic API didn't return state legislative districts
        if (stateHouseDistricts.length === 0 && stateSenateDistricts.length === 0) {
            console.log('No state legislative districts from Civic API, trying Census fallback...');
            const saved = this.getSavedAddress();
            const normAddr = saved?.normalizedAddress || {};
            const censusDistricts = await this._censusDistrictLookup(normAddr, saved?.address);
            for (const d of censusDistricts) {
                if (d.type === 'state-house') stateHouseDistricts.push(d.number);
                if (d.type === 'state-senate') stateSenateDistricts.push(d.number);
            }
            if (stateHouseDistricts.length > 0 || stateSenateDistricts.length > 0) {
                console.log('Census fallback found:', { stateHouseDistricts, stateSenateDistricts });
            } else {
                console.warn('Census fallback also returned no state districts');
            }
        }

        const stateLegs = allLegislators.filter(leg => {
            if (leg.state !== state) return false;
            if (leg.level !== 'State') return false;

            const chamber = (leg.chamber || '').toLowerCase();
            const dist = String(leg.district || '').replace(/^0+/, '');

            // Senate chamber: match state-senate districts
            if (chamber === 'senate' || chamber.includes('senate')) {
                if (stateSenateDistricts.length > 0) {
                    return stateSenateDistricts.some(d => String(d).replace(/^0+/, '') === dist);
                }
            }
            // House/Assembly/Legislature: match state-house districts
            if (chamber === 'house' || chamber.includes('house') || chamber.includes('assembly') || chamber === 'legislature') {
                if (stateHouseDistricts.length > 0) {
                    return stateHouseDistricts.some(d => String(d).replace(/^0+/, '') === dist);
                }
            }

            // NEVER fall back to all state legislators - if no districts found, skip state reps
            return false;
        });

        this._bills = bills;

        // Map federal seats to rep objects
        const federalReps = federalSeats.map(seat => {
            const inc = seat.incumbent || {};
            const rep = {
                name: inc.name || (seat.body + ' ' + (seat.district || '')).trim(),
                party: inc.party || '?',
                partyFull: inc.party === 'R' ? 'Republican' : inc.party === 'D' ? 'Democrat' : inc.party || '',
                office: seat.body + (seat.district ? ' District ' + seat.district : ''),
                level: seat.level || 'Federal',
                body: seat.body,
                phone: '',
                email: '',
                photoUrl: inc.photoUrl || '',
                state: state,
            };
            const intelMatch = this._matchIntelligence(rep, legislators);
            this._enrichContact(rep, intelMatch);
            const repBills = this._findRepBills(rep, bills);
            const primaryAction = this._determinePrimaryAction(rep, intelMatch, repBills);
            return { ...rep, seat, intel: intelMatch, bills: repBills, primaryAction, candidates: seat.candidates || [] };
        });

        // Map state legislators to rep objects
        const stateReps = stateLegs.map(leg => {
            const party = leg.party || 'Unknown';
            const partyShort = party.startsWith('Dem') ? 'D' : party.startsWith('Rep') ? 'R' : party.charAt(0);
            const contact = leg.contact || {};
            const rep = {
                name: leg.name,
                party: partyShort,
                partyFull: party,
                office: (leg.office || 'State ' + (leg.chamber || '')).trim() + (leg.district ? ' District ' + leg.district : ''),
                level: 'State',
                body: leg.office || 'State ' + (leg.chamber || ''),
                phone: contact.phone || '',
                email: contact.email || '',
                photoUrl: leg.photo_url || '',
                state: state,
                website: contact.website || '',
                contactForm: contact.contact_form || '',
            };
            const intelMatch = this._matchIntelligence(rep, legislators);
            this._enrichContact(rep, intelMatch);
            const repBills = this._findRepBills(rep, bills);
            const primaryAction = this._determinePrimaryAction(rep, intelMatch, repBills);
            return { ...rep, seat: null, intel: intelMatch, bills: repBills, primaryAction, candidates: [] };
        });

        // ── Fill in missing federal reps from legislators.json ──
        // seats.json may not have all senators (only those up for re-election)
        const federalNames = new Set(federalReps.map(r => r.name.toLowerCase()));
        const missingFederal = allLegislators.filter(leg => {
            if (leg.state !== state || leg.level !== 'Federal') return false;
            // Skip if already covered by seats.json
            const legName = (leg.name || '').toLowerCase();
            for (const fn of federalNames) {
                if (fn === legName || fn.includes(legName.split(' ').pop()) && legName.includes(fn.split(' ')[0])) return false;
            }
            // Include US Senators and Governor not already in federal reps
            const chamber = (leg.chamber || '').toLowerCase();
            if (chamber === 'senate') return true;
            return false;
        });

        const missingFederalReps = missingFederal.map(leg => {
            const party = leg.party || 'Unknown';
            const partyShort = party.startsWith('Dem') ? 'D' : party.startsWith('Rep') ? 'R' : party.charAt(0);
            const contact = leg.contact || {};
            const rep = {
                name: leg.name,
                party: partyShort,
                partyFull: party,
                office: leg.office || 'U.S. Senate',
                level: 'Federal',
                body: 'US Senate',
                phone: contact.phone || '',
                email: contact.email || '',
                photoUrl: leg.photo_url || '',
                state: state,
                website: contact.website || '',
                contactForm: contact.contact_form || '',
            };
            const intelMatch = this._matchIntelligence(rep, legislators);
            this._enrichContact(rep, intelMatch);
            const repBills = this._findRepBills(rep, bills);
            const primaryAction = this._determinePrimaryAction(rep, intelMatch, repBills);
            return { ...rep, seat: null, intel: intelMatch, bills: repBills, primaryAction, candidates: [] };
        });

        return [...federalReps, ...missingFederalReps, ...stateReps];
    },

    // ── Data Matching ─────────────────────────────

    async enrichReps(civicReps) {
        // Load all data sources in parallel
        const [seatsData, legislators, bills] = await Promise.all([
            fetch('data/seats.json').then(r => r.ok ? r.json() : { seats: [] }).catch(() => ({ seats: [] })),
            typeof IntelligenceAPI !== 'undefined' ? IntelligenceAPI.getLegislators().catch(() => []) : [],
            typeof LegislationAPI !== 'undefined' ? LegislationAPI.getLegislation(null).catch(() => []) : [],
        ]);

        const seats = seatsData.seats || [];
        this._bills = bills;

        return civicReps.map(rep => {
            // Match to seats.json
            const seatMatch = this._matchSeat(rep, seats);

            // Match to legislators.json intelligence
            const intelMatch = this._matchIntelligence(rep, legislators);

            // Find relevant bills
            const repBills = this._findRepBills(rep, bills);

            // Determine primary action
            const primaryAction = this._determinePrimaryAction(rep, intelMatch, repBills);

            return {
                ...rep,
                photoUrl: rep.photoUrl || (seatMatch?.incumbent?.photoUrl) || '',
                seat: seatMatch,
                intel: intelMatch,
                bills: repBills,
                primaryAction: primaryAction,
                candidates: seatMatch?.candidates || [],
            };
        });
    },

    _matchSeat(rep, seats) {
        const state = rep.state;
        if (!state) return null;

        // Try exact body match
        for (const seat of seats) {
            if (seat.state !== state) continue;

            if (rep.body === 'US Senate' && seat.body === 'US Senate') {
                // Match by incumbent name
                if (seat.incumbent && this._nameMatch(rep.name, seat.incumbent.name)) {
                    return seat;
                }
            }
            if (rep.body === 'US House' && seat.body === 'US House') {
                if (seat.incumbent && this._nameMatch(rep.name, seat.incumbent.name)) {
                    return seat;
                }
            }
            if (rep.body === 'Governor' && seat.body === 'Governor') {
                return seat;
            }
        }
        return null;
    },

    // Fill in missing contact info from the intelligence match
    _enrichContact(rep, intelMatch) {
        if (!intelMatch) return rep;
        const c = intelMatch.contact || {};
        if (!rep.email && c.email) rep.email = c.email;
        if (!rep.phone && c.phone) rep.phone = c.phone;
        if (!rep.website && c.website) rep.website = c.website;
        if (!rep.contactForm && c.contact_form) rep.contactForm = c.contact_form;
        if (!rep.photoUrl && intelMatch.photo_url) rep.photoUrl = intelMatch.photo_url;
        return rep;
    },

    _matchIntelligence(rep, legislators) {
        if (!legislators || legislators.length === 0) return null;

        const repName = rep.name.toLowerCase().replace(/^(rep\.|sen\.|dr\.|hon\.)\s*/i, '');

        for (const leg of legislators) {
            const legName = leg.name.toLowerCase().replace(/^(rep\.|sen\.|dr\.|hon\.)\s*/i, '');
            if (this._nameMatch(repName, legName)) {
                return leg;
            }
        }
        return null;
    },

    _nameMatch(a, b) {
        if (!a || !b) return false;
        const normalize = s => s.toLowerCase().replace(/[^a-z\s]/g, '').trim();
        const na = normalize(a);
        const nb = normalize(b);
        if (na === nb) return true;
        // Check if last names match + first initial
        const partsA = na.split(/\s+/);
        const partsB = nb.split(/\s+/);
        const lastA = partsA[partsA.length - 1];
        const lastB = partsB[partsB.length - 1];
        if (lastA === lastB && partsA[0][0] === partsB[0][0]) return true;
        return false;
    },

    _findRepBills(rep, bills) {
        if (!bills || bills.length === 0) return [];
        const state = rep.state;

        return bills.filter(bill => {
            if (bill.isActive !== 'Yes') return false;
            // Federal rep -> federal bills + their state bills
            if (rep.level === 'Federal') {
                return bill.level === 'Federal' || bill.state === state;
            }
            // State rep -> their state bills
            return bill.state === state;
        }).sort((a, b) => {
            // High impact first
            const impactOrder = { 'High': 0, 'Medium': 1, 'Low': 2 };
            return (impactOrder[a.impact] || 2) - (impactOrder[b.impact] || 2);
        });
    },

    _determinePrimaryAction(rep, intel, bills) {
        const score = 5;
        const category = 'unknown';

        // Priority 1: High-impact anti-science bill in committee
        const urgentBill = bills.find(b =>
            b.billType === 'anti' && b.impact === 'High' &&
            (b.status === 'In Committee' || b.status === 'Introduced')
        );
        if (urgentBill) {
            return {
                type: 'oppose-bill',
                priority: 1,
                label: `Urge to oppose ${urgentBill.billNumber}`,
                description: urgentBill.title,
                bill: urgentBill,
            };
        }

        // Priority 2: Any active anti-science bill
        const activeBill = bills.find(b => b.billType === 'anti' && b.isActive === 'Yes');
        if (activeBill) {
            return {
                type: 'oppose-bill',
                priority: 2,
                label: `Urge to oppose ${activeBill.billNumber}`,
                description: activeBill.title,
                bill: activeBill,
            };
        }

        // Priority 3: No pledge + fence-sitter or likely-win
        if (category === 'fence-sitter' || category === 'likely-win' || score >= 4) {
            return {
                type: 'ask-pledge',
                priority: 3,
                label: 'Ask to take the SAFE Action pledge',
                description: 'Help hold this official accountable on science policy',
            };
        }

        // Priority 4: Default pledge ask
        return {
            type: 'ask-pledge',
            priority: 4,
            label: 'Ask to take the SAFE Action pledge',
            description: 'Help hold this official accountable on science policy',
        };
    },

    // ── State Fallback ────────────────────────────

    async getRepsByState(stateCode) {
        const [seatsData, legislators, bills] = await Promise.all([
            fetch('data/seats.json').then(r => r.ok ? r.json() : { seats: [] }).catch(() => ({ seats: [] })),
            typeof IntelligenceAPI !== 'undefined' ? IntelligenceAPI.getLegislators(stateCode).catch(() => []) : [],
            typeof LegislationAPI !== 'undefined' ? LegislationAPI.getLegislation(stateCode).catch(() => []) : [],
        ]);

        const seats = (seatsData.seats || []).filter(s =>
            s.state === stateCode &&
            s.incumbent &&
            (s.body === 'US Senate' || s.body === 'US House' || s.body === 'Governor')
        );

        this._bills = bills;

        return seats.map(seat => {
            const inc = seat.incumbent || {};
            const rep = {
                name: inc.name || `${seat.body} ${seat.district || ''}`.trim(),
                party: inc.party || '?',
                partyFull: inc.party === 'R' ? 'Republican' : inc.party === 'D' ? 'Democrat' : inc.party || '',
                office: `${seat.body}${seat.district ? ' District ' + seat.district : ''}`,
                level: seat.level || 'Federal',
                body: seat.body,
                phone: '',
                email: '',
                photoUrl: inc.photoUrl || '',
                state: stateCode,
            };

            const intelMatch = this._matchIntelligence(rep, legislators);
            this._enrichContact(rep, intelMatch);
            const repBills = this._findRepBills(rep, bills);
            const primaryAction = this._determinePrimaryAction(rep, intelMatch, repBills);

            return {
                ...rep,
                seat: seat,
                intel: intelMatch,
                bills: repBills,
                primaryAction: primaryAction,
                candidates: seat.candidates || [],
            };
        });
    },
};
