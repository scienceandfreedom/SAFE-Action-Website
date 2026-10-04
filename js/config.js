// ============================================
// SAFE Action - Configuration
// ============================================
//
// HOW TO SET UP:
// 1. Create a Google Sheet with these column headers (Row 1):
//    Timestamp | First Name | Last Name | Email | Phone | Party | Office | Position | District | City | Vaccine Support | Question 1 | Question 2 | Question 3
//
// 2. Go to Extensions > Apps Script in your Google Sheet
// 3. Paste the code from google-apps-script.js into the script editor
// 4. Deploy as a Web App:
//    - Click Deploy > New Deployment
//    - Select "Web app"
//    - Set "Execute as" to "Me"
//    - Set "Who has access" to "Anyone"
//    - Click Deploy
//    - Copy the Web App URL
//
// 5. Paste the Web App URL below:
//
const SAFE_CONFIG = {
    // Replace this URL with your deployed Google Apps Script Web App URL
    GOOGLE_SCRIPT_URL: 'YOUR_GOOGLE_APPS_SCRIPT_URL_HERE',

    // How often to refresh data (in milliseconds) - Default: 5 minutes
    CACHE_DURATION: 5 * 60 * 1000,

    // Set to true once you've configured the Google Script URL above
    IS_CONFIGURED: false,

    // Google Civic Information API key (free tier, 25k req/day)
    // Get one at: https://console.cloud.google.com/apis/credentials
    GOOGLE_CIVIC_API_KEY: 'AIzaSyBapcQaTbdLhAZVc5p9KUckaw5zk_hLtzs',

    // Google Maps JavaScript API key (for Places Autocomplete on address input)
    GOOGLE_MAPS_API_KEY: 'AIzaSyB2keV-yEl6Ra-Qf1zxZso4r00GEc5dAUI',

    // All 50 states + DC + Federal
    STATES: {
        'US': 'Federal (U.S. Congress)',
        'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
        'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
        'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
        'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
        'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine',
        'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
        'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
        'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
        'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
        'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
        'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
        'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
        'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
    },

    // Bill status progression order (for pipeline visualization)
    STATUS_ORDER: [
        'Pre-filed', 'Introduced', 'In Committee', 'Passed Committee',
        'Floor Vote Scheduled', 'Passed One Chamber', 'In Conference',
        'Passed Both Chambers', 'Sent to Governor', 'Signed into Law'
    ],

    // Dead-end statuses
    DEAD_STATUSES: ['Vetoed', 'Died in Committee', 'Failed', 'Tabled', 'Withdrawn'],

    // Intelligence data path (relative to site root)
    INTELLIGENCE_DATA_PATH: 'data/',

    // Persuadability categories
    PERSUADABILITY_CATEGORIES: [
        'champion', 'likely-win', 'fence-sitter', 'unlikely', 'opposed'
    ],

    // Firebase configuration (fill in after creating Firebase project)
    // 1. Go to https://console.firebase.google.com
    // 2. Create project "safe-action" (or similar)
    // 3. Enable Authentication > Google provider
    // 4. Enable Cloud Firestore (us-central1)
    // 5. Add scienceandfreedom.com to Auth > Settings > Authorized domains
    // 6. Copy config from Project Settings > General > Your apps > Web app
    // Base action counts: baselines carried over from the previous tracker
    // (operator-confirmed 2026-08). Displayed totals = baseline + live Firestore counts.
    BASE_ACTIONS: 1128,
    BASE_EMAILS: 743,
    BASE_CALLS: 385,

    FIREBASE_CONFIG: {
        apiKey: 'AIzaSyDQul9vsl7oEj43VSlzLi_S4SXrm3liZWc',
        // Same-origin auth helper (served at scienceandfreedom.com/__/auth/) so
        // the Google sign-in popup is first-party. The old third-party
        // firebaseapp.com handoff gets killed by Chrome's third-party-cookie
        // blocking / privacy extensions, surfacing as auth/internal-error.
        authDomain: 'scienceandfreedom.com',
        projectId: 'safe-action-website',
        storageBucket: 'safe-action-website.firebasestorage.app',
        messagingSenderId: '1035666846416',
        appId: '1:1035666846416:web:1c0bac14e6569b4f41a4d5'
    }
};
