// ============================================
// SAFE Action - My Representatives Page Controller
// ============================================

document.addEventListener('DOMContentLoaded', () => {
    // ── Tab Switching ────────────────────────────
    document.querySelectorAll('.sub-nav-link[data-tab]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var tabId = this.getAttribute('data-tab');
            // Update active button
            document.querySelectorAll('.sub-nav-link[data-tab]').forEach(function(b) {
                b.classList.remove('active');
            });
            this.classList.add('active');
            // Update active panel
            document.querySelectorAll('.tab-panel').forEach(function(panel) {
                panel.style.display = 'none';
                panel.classList.remove('active');
            });
            var target = document.getElementById('tab-' + tabId);
            if (target) {
                target.style.display = '';
                target.classList.add('active');
            }
            // Lazy-init bill browser
            if (tabId === 'browse-bills') {
                BillBrowser.init();
            }
        });
    });

    // Handle hash-based tab navigation (e.g., outreach.html#take-pledge)
    // Also auto-open browse-bills if URL has filter params
    var hash = window.location.hash.replace('#', '');
    var params = new URLSearchParams(window.location.search);
    var billFilterKeys = ['state', 'type', 'status', 'priority', 'category', 'q'];
    var hasBillFilters = billFilterKeys.some(function(k) { return params.has(k); });
    if (hasBillFilters && !hash) hash = 'browse-bills';
    if (hash) {
        var hashBtn = document.querySelector('.sub-nav-link[data-tab="' + hash + '"]');
        if (hashBtn) hashBtn.click();
    }

    const addressForm = document.getElementById('address-form');
    const addressInput = document.getElementById('address-input');
    const addressSection = document.getElementById('address-section');
    const savedAddressBar = document.getElementById('saved-address-bar');
    const savedAddressText = document.getElementById('saved-address-text');
    const changeAddressBtn = document.getElementById('change-address-btn');
    const stateFallback = document.getElementById('state-fallback');
    const stateSelect = document.getElementById('state-select');
    const stateLookupBtn = document.getElementById('state-lookup-btn');
    const repGrid = document.getElementById('rep-grid');
    const repSection = document.getElementById('rep-section');
    const statsBar = document.getElementById('hub-stats');
    const loadingEl = document.getElementById('hub-loading');
    const errorEl = document.getElementById('hub-error');

    // Escape HTML to prevent XSS from API data
    function esc(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = String(str);
        return div.innerHTML;
    }

    function escapeAttr(str) {
        return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ── Personalization (name + city for templates) ──
    const PERSON_KEY = 'safe_user_info';
    function getUserInfo() {
        try {
            return JSON.parse(localStorage.getItem(PERSON_KEY)) || {};
        } catch(e) { return {}; }
    }
    function saveUserInfo(name, city) {
        localStorage.setItem(PERSON_KEY, JSON.stringify({ name: name, city: city }));
    }
    function getUserName() { return getUserInfo().name || ''; }
    function getUserCity() { return getUserInfo().city || ''; }

    // ── Anti-Spam Contact Tracking ──────────────────
    var CONTACT_LOG_KEY = 'safe_contact_log';

    function getContactKey(rep) {
        return (rep.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    }

    function getContactLog() {
        try { return JSON.parse(localStorage.getItem(CONTACT_LOG_KEY)) || {}; }
        catch(e) { return {}; }
    }

    function logContact(rep, method) {
        var log = getContactLog();
        var today = new Date().toISOString().split('T')[0];
        if (!log[today]) log[today] = {};
        var key = getContactKey(rep);
        if (!log[today][key]) log[today][key] = { emails: 0, calls: 0, lastEmail: 0 };
        if (method === 'email') {
            log[today][key].emails++;
            log[today][key].lastEmail = Date.now();
        } else if (method === 'call') {
            log[today][key].calls++;
        }
        // Clean out entries older than 7 days
        var cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - 7);
        var cutoffStr = cutoff.toISOString().split('T')[0];
        Object.keys(log).forEach(function(d) { if (d < cutoffStr) delete log[d]; });
        localStorage.setItem(CONTACT_LOG_KEY, JSON.stringify(log));
    }

    function getContactCount(rep) {
        var log = getContactLog();
        var today = new Date().toISOString().split('T')[0];
        var key = getContactKey(rep);
        if (log[today] && log[today][key]) return log[today][key];
        return { emails: 0, calls: 0, lastEmail: 0 };
    }

    function shouldSuggestCallInstead(rep) {
        return getContactCount(rep).emails >= 2;
    }

    // ── Contact Prioritization ──────────────────────
    // Returns { method, label, url, priority }
    function getBestContactMethod(rep) {
        if (rep.email) {
            return { method: 'email', label: 'Email', url: 'mailto:' + rep.email, priority: 1 };
        }
        // Contact form
        var contactUrl = rep.contactForm || '';
        if (!contactUrl && rep.website) {
            contactUrl = rep.website.replace(/\/+$/, '') + '/contact';
        }
        if (contactUrl) {
            return { method: 'contact_form', label: 'Contact Form', url: contactUrl, priority: 2 };
        }
        // FEC filing (lowest priority)
        if (rep.fecId) {
            return { method: 'fec', label: 'FEC Page', url: 'https://www.fec.gov/data/candidate/' + rep.fecId + '/', priority: 3 };
        }
        // Nothing
        return { method: 'none', label: 'No Contact Info', url: '', priority: 4 };
    }


    // Check if Civic API is available
    const hasCivicKey = SAFE_CONFIG.GOOGLE_CIVIC_API_KEY && SAFE_CONFIG.GOOGLE_CIVIC_API_KEY.length > 5;

    // Show/hide address vs state fallback
    if (!hasCivicKey) {
        if (addressSection) addressSection.style.display = 'none';
        if (stateFallback) stateFallback.style.display = '';
        populateStateDropdown();
    } else {
        if (stateFallback) stateFallback.style.display = 'none';
    }

    // Check for address in URL query params (e.g., outreach.html?address=123+Main+St)
    const urlAddress = params.get('address');
    if (urlAddress && hasCivicKey && addressInput) {
        addressInput.value = urlAddress;
        doAddressLookup(urlAddress);
    } else {
        // Check for saved address on load
        const saved = MyRepsHub.getSavedAddress();
        if (saved && hasCivicKey) {
            showSavedAddress(saved.address);
            loadFromSaved(saved);
        }
    }

    // Address form submission
    if (addressForm) {
        addressForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const address = addressInput.value.trim();
            if (!address) return;
            await doAddressLookup(address);
        });
    }

    // ── Google Places Autocomplete ──────────────────
    // Validates the API key works before loading the full Maps JS SDK,
    // to avoid Google's intrusive error dialogs when APIs aren't enabled.
    function initAddressAutocomplete() {
        if (!addressInput) return;

        var apiKey = SAFE_CONFIG.GOOGLE_MAPS_API_KEY || SAFE_CONFIG.GOOGLE_CIVIC_API_KEY;
        if (!apiKey) return;

        // Load Places SDK directly (referer-restricted keys can't use REST geocoding validation)
        loadPlacesScript(apiKey);
    }

    function loadPlacesScript(apiKey) {
        var script = document.createElement('script');
        script.src = 'https://maps.googleapis.com/maps/api/js?key=' + apiKey + '&libraries=places&callback=__initSAFEPlaces';
        script.async = true;
        script.defer = true;
        script.onerror = function() {
            console.warn('Google Places API not available');
        };

        window.__initSAFEPlaces = function() {
            try {
                var autocomplete = new google.maps.places.Autocomplete(addressInput, {
                    types: ['address'],
                    componentRestrictions: { country: 'us' },
                    fields: ['formatted_address', 'address_components']
                });

                autocomplete.addListener('place_changed', function() {
                    var place = autocomplete.getPlace();
                    if (place && place.formatted_address) {
                        addressInput.value = place.formatted_address;
                        setTimeout(function() {
                            if (addressForm) {
                                addressForm.dispatchEvent(new Event('submit', { cancelable: true }));
                            }
                        }, 100);
                    }
                });

                addressInput.setAttribute('placeholder', 'Start typing your address...');
            } catch (e) {
                console.warn('Places Autocomplete init failed:', e);
                cleanupPlacesWidget();
            }
        };

        document.head.appendChild(script);
    }

    function cleanupPlacesWidget() {
        var pacContainers = document.querySelectorAll('.pac-container');
        pacContainers.forEach(function(el) { el.remove(); });
        if (addressInput) {
            addressInput.removeAttribute('aria-expanded');
            addressInput.removeAttribute('aria-owns');
            addressInput.removeAttribute('aria-autocomplete');
            addressInput.classList.remove('pac-target-input');
        }
        // Hide any remaining Google-injected elements
        var style = document.createElement('style');
        style.textContent = '.pac-icon, .pac-container, .pac-item, .dismissButton, .gm-err-container, .gm-style-pbc { display: none !important; }';
        document.head.appendChild(style);
    }

    initAddressAutocomplete();

    // Change address
    if (changeAddressBtn) {
        changeAddressBtn.addEventListener('click', () => {
            MyRepsHub.clearSavedAddress();
            if (savedAddressBar) savedAddressBar.style.display = 'none';
            if (addressSection) addressSection.style.display = '';
            if (repSection) repSection.style.display = 'none';
            if (statsBar) statsBar.style.display = 'none';
            if (typeof CountyReport !== 'undefined') CountyReport.hide();
            if (addressInput) { addressInput.value = ''; addressInput.focus(); }
        });
    }

    // State fallback
    if (stateLookupBtn) {
        stateLookupBtn.addEventListener('click', async () => {
            const state = stateSelect.value;
            if (!state) return;
            await doStateLookup(state);
        });
    }
    if (stateSelect) {
        stateSelect.addEventListener('change', async () => {
            const state = stateSelect.value;
            if (state) await doStateLookup(state);
        });
    }

    function populateStateDropdown() {
        if (!stateSelect) return;
        const states = SAFE_CONFIG.STATES;
        Object.keys(states).forEach(code => {
            if (code === 'US') return;
            const opt = document.createElement('option');
            opt.value = code;
            opt.textContent = states[code];
            stateSelect.appendChild(opt);
        });
    }

    function showSavedAddress(address) {
        if (savedAddressBar) {
            savedAddressBar.style.display = '';
            if (savedAddressText) savedAddressText.textContent = address;
        }
        if (addressSection) addressSection.style.display = 'none';
    }

    function showLoading() {
        if (typeof CountyReport !== 'undefined') CountyReport.hide();
        if (loadingEl) loadingEl.style.display = '';
        if (repGrid) repGrid.textContent = '';
        if (repSection) repSection.style.display = '';
        if (errorEl) errorEl.style.display = 'none';
    }

    function hideLoading() {
        if (loadingEl) loadingEl.style.display = 'none';
    }

    function showError(msg) {
        hideLoading();
        if (errorEl) {
            errorEl.style.display = '';
            errorEl.querySelector('p').textContent = msg;
        }
    }

    function autofillCityFromAddress() {
        try {
            var saved = JSON.parse(localStorage.getItem(MyRepsHub.STORAGE_KEY));
            if (!saved) return;

            var city = '';
            var state = saved.state || '';

            // Prefer parsing city from the original address the user typed
            // (Civic API normalizedInput sometimes returns wrong city)
            if (saved.address) {
                var parts = saved.address.split(',').map(function(s) { return s.trim(); });
                // Typical format: "123 Street, City, ST 12345" or "123 Street, City, ST"
                if (parts.length >= 3) {
                    city = parts[1]; // second part is usually the city
                } else if (parts.length === 2) {
                    // Could be "City, ST" or "Street, City"
                    var secondPart = parts[1].trim();
                    if (/^[A-Z]{2}\b/.test(secondPart) || /\d{5}/.test(secondPart)) {
                        city = parts[0]; // first part is city
                    } else {
                        city = secondPart;
                    }
                }
            }

            // Fall back to normalizedAddress if we couldn't parse
            if (!city && saved.normalizedAddress) {
                city = saved.normalizedAddress.city || '';
                if (!state) state = saved.normalizedAddress.state || '';
            }

            var cityState = city && state ? city + ', ' + state : city || state || '';
            if (cityState) {
                // Always update city when a new address is looked up
                saveUserInfo(getUserName(), cityState);
                var cityInput = document.getElementById('email-all-city');
                if (cityInput) {
                    cityInput.value = cityState;
                }
            }
        } catch (e) {}
    }

    async function doAddressLookup(address) {
        showLoading();
        const reps = await MyRepsHub.lookupAddress(address);
        if (!reps || reps.length === 0) {
            showError('Could not find representatives for that address. Please check the address and try again.');
            return;
        }
        showSavedAddress(address);
        hideLoading();
        renderReps(reps);
        autofillCityFromAddress();
        showCountyReport(MyRepsHub.getSavedAddress(), reps);
    }

    async function loadFromSaved(saved) {
        showLoading();
        // New saved format has state + districts instead of officials/offices
        if (saved.state) {
            const parsed = { state: saved.state, districts: saved.districts || [] };
            const reps = await MyRepsHub._loadRepsFromDivisions(parsed);
            hideLoading();
            renderReps(reps);
            autofillCityFromAddress();
            showCountyReport(saved, reps);
        } else {
            // Legacy fallback: use state from address
            hideLoading();
            showError('Saved address format outdated. Please enter your address again.');
        }
    }

    async function doStateLookup(stateCode) {
        showLoading();
        const reps = await MyRepsHub.getRepsByState(stateCode);
        hideLoading();
        if (reps.length === 0) {
            showError('No federal representatives found for this state.');
            return;
        }
        renderReps(reps);
        showCountyReport({ state: stateCode }, reps);
    }

    // County report card (js/county-report.js). Optional: pages that do not load
    // that script or have no #county-report element skip it, and a failure there
    // never affects the representative list.
    function showCountyReport(loc, reps) {
        if (typeof CountyReport === 'undefined' || !loc) return;
        CountyReport.show(loc, reps);
    }

    var _currentReps = [];

    function renderReps(reps) {
        if (!repGrid) return;
        _currentReps = reps;

        // Sort by action priority (most urgent first)
        reps.sort(function(a, b) { return (a.primaryAction ? a.primaryAction.priority : 9) - (b.primaryAction ? b.primaryAction.priority : 9); });

        // Update stats
        renderStats(reps);

        // Build the dominant hero CTA (replaces old personalize bar + email all bar)
        buildEmailAllHero(reps);

        // Build cards inside a collapsible container
        repGrid.textContent = '';
        reps.forEach(function(rep, i) {
            var card = buildRepCard(rep, i, reps);
            repGrid.appendChild(card);
        });

        // Collapse the rep list by default - hero CTA is the star
        buildRepListToggle(reps);

        if (repSection) repSection.style.display = '';
        if (statsBar) statsBar.style.display = '';
    }

    // ── Collapsible Rep List ────────────────────────
    function buildRepListToggle(reps) {
        var existing = document.getElementById('rep-list-toggle');
        if (existing) existing.remove();

        if (!repGrid || reps.length === 0) return;

        // Hide grid by default
        repGrid.style.display = 'none';

        var toggleBtn = document.createElement('button');
        toggleBtn.id = 'rep-list-toggle';
        toggleBtn.className = 'rep-list-toggle-btn';
        toggleBtn.innerHTML = '<span class="toggle-icon">&#9660;</span> Show Individual Representatives (' + reps.length + ')';

        toggleBtn.addEventListener('click', function() {
            var isHidden = repGrid.style.display === 'none';
            repGrid.style.display = isHidden ? '' : 'none';
            toggleBtn.innerHTML = (isHidden ? '<span class="toggle-icon">&#9650;</span> Hide Individual Representatives' : '<span class="toggle-icon">&#9660;</span> Show Individual Representatives (' + reps.length + ')');
        });

        // Insert right before the grid
        if (repGrid.parentNode) {
            repGrid.parentNode.insertBefore(toggleBtn, repGrid);
        }
    }

    function validatePersonalizeInputs() {
        var nameInput = document.getElementById('email-all-name');
        var cityInput = document.getElementById('email-all-city');
        var name = nameInput ? nameInput.value.trim() : '';
        var city = cityInput ? cityInput.value.trim() : '';
        if (!name) { if (nameInput) { nameInput.focus(); nameInput.style.borderColor = '#B22234'; } return false; }
        if (!city) { if (cityInput) { cityInput.focus(); cityInput.style.borderColor = '#B22234'; } return false; }
        saveUserInfo(name, city);
        return true;
    }

    // ── Hero CTA (replaces buildPersonalizeBar + buildEmailAllBar) ──
    function buildEmailAllHero(reps) {
        // Remove old elements
        var old1 = document.getElementById('personalize-bar');
        var old2 = document.getElementById('email-all-bar');
        var old3 = document.getElementById('email-all-hero');
        if (old1) old1.remove();
        if (old2) old2.remove();
        if (old3) old3.remove();

        if (reps.length === 0) return;

        var hero = document.createElement('div');
        hero.id = 'email-all-hero';
        hero.className = 'email-all-hero';

        // Emoji banner
        var emoji = document.createElement('div');
        emoji.className = 'hero-emoji';
        emoji.textContent = '\u2709\uFE0F';
        hero.appendChild(emoji);

        // Heading
        var heading = document.createElement('h2');
        heading.className = 'hero-heading';
        heading.textContent = 'Email All ' + reps.length + ' Representatives';
        hero.appendChild(heading);

        var desc = document.createElement('p');
        desc.className = 'hero-desc';
        desc.textContent = 'Send each representative a unique, personalized email in just a few clicks. Each email uses a different template to avoid spam filters.';
        hero.appendChild(desc);

        // Inline name/city inputs
        var inputRow = document.createElement('div');
        inputRow.className = 'hero-input-row';

        var nameGroup = document.createElement('div');
        nameGroup.className = 'hero-input-group';
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.id = 'email-all-name';
        nameInput.placeholder = 'Your Name';
        nameInput.value = getUserName();
        nameInput.className = 'hero-input';
        nameInput.addEventListener('change', function() {
            var cityEl = document.getElementById('email-all-city');
            saveUserInfo(nameInput.value.trim(), cityEl ? cityEl.value.trim() : '');
        });
        nameGroup.appendChild(nameInput);
        inputRow.appendChild(nameGroup);

        var cityGroup = document.createElement('div');
        cityGroup.className = 'hero-input-group';
        var cityInput = document.createElement('input');
        cityInput.type = 'text';
        cityInput.id = 'email-all-city';
        cityInput.placeholder = 'Your City';
        cityInput.value = getUserCity();
        cityInput.className = 'hero-input';
        cityInput.addEventListener('change', function() {
            var nameEl = document.getElementById('email-all-name');
            saveUserInfo(nameEl ? nameEl.value.trim() : '', cityInput.value.trim());
        });
        cityGroup.appendChild(cityInput);
        inputRow.appendChild(cityGroup);

        hero.appendChild(inputRow);

        // Button row
        var btnRow = document.createElement('div');
        btnRow.className = 'hero-btn-row';

        var emailAllBtn = document.createElement('button');
        emailAllBtn.className = 'btn btn-primary hero-email-btn pulse-btn';
        emailAllBtn.innerHTML = '\u2709\uFE0F Email All ' + reps.length + ' Reps';
        emailAllBtn.addEventListener('click', function() {
            if (!validatePersonalizeInputs()) return;
            emailAllReps(reps, emailAllBtn, hero);
        });
        btnRow.appendChild(emailAllBtn);

        var callBtn = document.createElement('button');
        callBtn.className = 'btn btn-outline hero-call-btn';
        callBtn.innerHTML = '\uD83D\uDCDE Call/Text Reps Instead';
        callBtn.addEventListener('click', function() {
            if (!validatePersonalizeInputs()) return;
            startCallTextMode(reps);
        });
        btnRow.appendChild(callBtn);

        hero.appendChild(btnRow);

        // Insert after stats bar
        if (statsBar && statsBar.parentNode) {
            statsBar.parentNode.insertBefore(hero, statsBar.nextSibling);
        }
    }

    // ── Rep-by-Rep Call/Text Mode ──────────────────
    function startCallTextMode(reps) {
        // Filter to reps that have a phone number
        var callableReps = reps.filter(function(r) { return r.phone; });
        if (callableReps.length === 0) {
            showToast('None of your representatives have phone numbers on file. Try email instead!');
            return;
        }

        var idx = 0;
        var userName = getUserName();
        var userCity = getUserCity();

        // Create full-screen overlay
        var overlay = document.createElement('div');
        overlay.className = 'call-text-overlay';

        function renderCallCard() {
            overlay.textContent = '';

            if (idx >= callableReps.length) {
                // Done
                var doneCard = document.createElement('div');
                doneCard.className = 'call-card call-card-done';
                doneCard.innerHTML = '<div class="call-card-emoji">\u2705</div>';
                var doneH = document.createElement('h2');
                doneH.textContent = 'All Done!';
                doneCard.appendChild(doneH);
                var doneP = document.createElement('p');
                doneP.textContent = 'You reached out to ' + callableReps.length + ' representative' + (callableReps.length > 1 ? 's' : '') + '. Thank you for taking action!';
                doneCard.appendChild(doneP);
                // PWA install prompt for engaged users
                if (typeof createPostActionInstallBtn === 'function') {
                    var pwaBtn = createPostActionInstallBtn();
                    if (pwaBtn) doneCard.appendChild(pwaBtn);
                }
                var closeBtn = document.createElement('button');
                closeBtn.className = 'btn btn-primary';
                closeBtn.textContent = 'Close';
                closeBtn.addEventListener('click', function() { overlay.remove(); });
                doneCard.appendChild(closeBtn);
                overlay.appendChild(doneCard);
                return;
            }

            var rep = callableReps[idx];
            var action = rep.primaryAction || {};
            var script = generatePhoneScript(rep, action, userName, userCity);

            var card = document.createElement('div');
            card.className = 'call-card';

            // Progress
            var progress = document.createElement('div');
            progress.className = 'call-card-progress';
            progress.textContent = 'Rep ' + (idx + 1) + ' of ' + callableReps.length;
            card.appendChild(progress);

            // Rep info
            var repHeader = document.createElement('div');
            repHeader.className = 'call-card-header';

            if (rep.photoUrl) {
                var photo = document.createElement('img');
                photo.src = rep.photoUrl;
                photo.alt = rep.name;
                photo.className = 'call-card-photo';
                photo.onerror = function() { this.style.display = 'none'; };
                repHeader.appendChild(photo);
            }
            var repInfo = document.createElement('div');
            var repName = document.createElement('h3');
            repName.textContent = rep.name;
            repInfo.appendChild(repName);
            var repMeta = document.createElement('p');
            repMeta.className = 'call-card-meta';
            var partyLabel = rep.party === 'R' ? 'Republican' : rep.party === 'D' ? 'Democrat' : rep.partyFull || rep.party;
            repMeta.textContent = partyLabel + ' - ' + rep.office;
            repInfo.appendChild(repMeta);
            repHeader.appendChild(repInfo);
            card.appendChild(repHeader);

            // Phone number (large, tappable)
            var phoneLink = document.createElement('a');
            phoneLink.href = 'tel:' + rep.phone;
            phoneLink.className = 'call-card-phone';
            phoneLink.textContent = '\uD83D\uDCDE ' + rep.phone;
            card.appendChild(phoneLink);

            // Phone script
            var scriptLabel = document.createElement('div');
            scriptLabel.className = 'call-card-script-label';
            scriptLabel.textContent = 'Phone Script (tap to copy):';
            card.appendChild(scriptLabel);

            var scriptBox = document.createElement('pre');
            scriptBox.className = 'call-card-script';
            scriptBox.textContent = script;
            scriptBox.addEventListener('click', function() {
                navigator.clipboard.writeText(script).then(function() {
                    showToast('Phone script copied!');
                }).catch(function(err) { console.warn('SAFE Action:', err.message || err); });
            });
            card.appendChild(scriptBox);

            // Action buttons
            var btnRow = document.createElement('div');
            btnRow.className = 'call-card-btns';

            var calledBtn = document.createElement('button');
            calledBtn.className = 'btn btn-primary';
            calledBtn.textContent = '\u2705 I Called';
            calledBtn.addEventListener('click', function() {
                logContact(rep, 'call');
                trackAction('call');
                idx++;
                renderCallCard();
            });
            btnRow.appendChild(calledBtn);

            var textBtn = document.createElement('a');
            textBtn.href = 'sms:' + rep.phone;
            textBtn.className = 'btn btn-outline';
            textBtn.style.textDecoration = 'none';
            textBtn.textContent = '\uD83D\uDCF1 Text Instead';
            textBtn.addEventListener('click', function() {
                logContact(rep, 'call');
                trackAction('call');
            });
            btnRow.appendChild(textBtn);

            var skipBtn = document.createElement('button');
            skipBtn.className = 'btn btn-outline call-card-skip';
            skipBtn.textContent = 'Skip';
            skipBtn.addEventListener('click', function() {
                idx++;
                renderCallCard();
            });
            btnRow.appendChild(skipBtn);

            card.appendChild(btnRow);

            // Close X
            var closeX = document.createElement('button');
            closeX.className = 'call-card-close';
            closeX.innerHTML = '&times;';
            closeX.addEventListener('click', function() { overlay.remove(); });
            card.appendChild(closeX);

            overlay.appendChild(card);
        }

        renderCallCard();
        document.body.appendChild(overlay);
    }

    function emailAllReps(reps, startBtn, bar) {
        // Sort: direct emails first, then contact forms, then others
        // This keeps users on-site longer before navigating away
        reps = reps.slice().sort(function(a, b) {
            return getBestContactMethod(a).priority - getBestContactMethod(b).priority;
        });

        var idx = 0;
        var total = reps.length;
        var userName = getUserName();
        var userCity = getUserCity();

        // Replace the hero/bar content with a step-by-step UI
        bar.textContent = '';
        bar.className = 'email-all-bar'; // Use the step-through styling
        var inner = document.createElement('div');
        inner.className = 'email-all-inner';
        bar.appendChild(inner);

        // Progress header
        var progressHeader = document.createElement('div');
        progressHeader.className = 'email-all-text';
        inner.appendChild(progressHeader);

        // Current rep info area
        var repInfo = document.createElement('div');
        repInfo.className = 'email-all-rep-info';
        repInfo.style.cssText = 'background:rgba(255,255,255,0.1);border-radius:8px;padding:12px 16px;margin:8px 0;';
        inner.appendChild(repInfo);

        // Button area
        var btnArea = document.createElement('div');
        btnArea.className = 'email-all-buttons';
        btnArea.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
        inner.appendChild(btnArea);

        function showStep() {
            if (idx >= total) {
                // Collect candidates that actually have contact info (email or website)
                var allCandidates = [];
                var seenNames = {};
                reps.forEach(function(rep) {
                    if (rep.candidates && rep.candidates.length > 0) {
                        rep.candidates.forEach(function(cand) {
                            // Only include candidates with email - skip paper filers with no contact
                            if (cand.name && cand.name !== rep.name && cand.email && !seenNames[cand.name]) {
                                seenNames[cand.name] = true;
                                allCandidates.push({
                                    name: cand.name,
                                    party: cand.party || '?',
                                    partyFull: cand.party === 'R' ? 'Republican' : cand.party === 'D' ? 'Democrat' : cand.party || '',
                                    office: rep.office + ' (Candidate)',
                                    email: cand.email,
                                    website: cand.website || '',
                                    contactForm: cand.contact_form || cand.contactForm || '',
                                });
                            }
                        });
                    }
                });

                if (allCandidates.length > 0) {
                    progressHeader.innerHTML = '<strong>Representatives Done!</strong><p>You contacted all ' + total + ' current representatives. There are also <strong>' + allCandidates.length + ' candidates</strong> running for office. Ask them to take the SAFE Action pledge too!</p>';
                    repInfo.style.display = 'none';
                    btnArea.textContent = '';

                    var emailCandsBtn = document.createElement('button');
                    emailCandsBtn.className = 'btn btn-primary';
                    emailCandsBtn.textContent = 'Email ' + allCandidates.length + ' Candidates';
                    emailCandsBtn.addEventListener('click', function() {
                        emailAllCandidates(allCandidates, bar);
                    });
                    btnArea.appendChild(emailCandsBtn);

                    var skipCandsBtn = document.createElement('button');
                    skipCandsBtn.className = 'btn btn-outline';
                    skipCandsBtn.style.cssText = 'border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
                    skipCandsBtn.textContent = "I'm Done";
                    skipCandsBtn.addEventListener('click', function() {
                        buildEmailAllHero(_currentReps);
                    });
                    btnArea.appendChild(skipCandsBtn);
                } else {
                    progressHeader.innerHTML = '<strong>All Done!</strong><p>You contacted all ' + total + ' representatives. Thank you for taking action!</p>';
                    repInfo.style.display = 'none';
                    btnArea.textContent = '';
                    // PWA install prompt for engaged users
                    if (typeof createPostActionInstallBtn === 'function') {
                        var pwaBtn = createPostActionInstallBtn();
                        if (pwaBtn) btnArea.appendChild(pwaBtn);
                    }
                    var doneBtn = document.createElement('button');
                    doneBtn.className = 'btn btn-primary';
                    doneBtn.textContent = 'Finished';
                    doneBtn.addEventListener('click', function() {
                        buildEmailAllHero(_currentReps);
                    });
                    btnArea.appendChild(doneBtn);
                }
                return;
            }

            var rep = reps[idx];
            progressHeader.innerHTML = '<strong>Representative ' + (idx + 1) + ' of ' + total + '</strong>';

            // Show rep details
            var partyLabel = rep.party === 'R' ? 'Republican' : rep.party === 'D' ? 'Democrat' : rep.partyFull || rep.party;
            repInfo.style.display = '';
            repInfo.innerHTML = '';
            var repName = document.createElement('div');
            repName.style.cssText = 'font-weight:700;font-size:1.05rem;color:#fff;';
            repName.textContent = rep.name;
            repInfo.appendChild(repName);
            var repDetail = document.createElement('div');
            repDetail.style.cssText = 'font-size:0.85rem;color:rgba(255,255,255,0.75);margin-top:2px;';
            repDetail.textContent = partyLabel + ' - ' + rep.office;
            repInfo.appendChild(repDetail);
            if (rep.email) {
                var repEmail = document.createElement('div');
                repEmail.style.cssText = 'font-size:0.85rem;color:rgba(255,255,255,0.6);margin-top:2px;';
                repEmail.textContent = rep.email;
                repInfo.appendChild(repEmail);
            }

            // Action buttons
            btnArea.textContent = '';

            // Use contact prioritization
            var contact = getBestContactMethod(rep);

            // Anti-spam check
            if (shouldSuggestCallInstead(rep)) {
                var spamNotice = document.createElement('div');
                spamNotice.className = 'anti-spam-notice';
                spamNotice.innerHTML = "You've already emailed <strong>" + esc(rep.name) + "</strong> today. Try calling instead!";
                btnArea.appendChild(spamNotice);

                if (rep.phone) {
                    var callInstead = document.createElement('a');
                    callInstead.href = 'tel:' + rep.phone;
                    callInstead.className = 'btn btn-primary';
                    callInstead.style.textDecoration = 'none';
                    callInstead.textContent = '\uD83D\uDCDE Call ' + rep.name.split(' ').pop();
                    btnArea.appendChild(callInstead);

                    var textInstead = document.createElement('a');
                    textInstead.href = 'sms:' + rep.phone;
                    textInstead.className = 'btn btn-outline';
                    textInstead.style.cssText = 'text-decoration:none;border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
                    textInstead.textContent = '\uD83D\uDCF1 Text';
                    btnArea.appendChild(textInstead);
                }

                var emailAnywayBtn = document.createElement('button');
                emailAnywayBtn.className = 'btn btn-outline';
                emailAnywayBtn.style.cssText = 'border-color:rgba(255,255,255,0.3);color:rgba(255,255,255,0.6);font-size:0.85rem;';
                emailAnywayBtn.textContent = 'Email Anyway';
                emailAnywayBtn.addEventListener('click', function() {
                    // Remove notice and re-render without anti-spam
                    spamNotice.remove();
                    emailAnywayBtn.remove();
                    if (callInstead) callInstead.remove();
                    if (textInstead) textInstead.remove();
                    renderEmailButton();
                });
                btnRow = document.createElement('div');
                btnRow.style.cssText = 'margin-top:8px;';
                btnRow.appendChild(emailAnywayBtn);
                btnArea.appendChild(btnRow);

                // Skip button
                var skipBtnSpam = document.createElement('button');
                skipBtnSpam.className = 'btn btn-outline';
                skipBtnSpam.style.cssText = 'border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
                skipBtnSpam.textContent = 'Skip';
                skipBtnSpam.addEventListener('click', function() { idx++; showStep(); });
                btnArea.appendChild(skipBtnSpam);
                return;
            }

            renderEmailButton();
            function renderEmailButton() {

            // Pre-generate the template for this rep
            var pledgeAction = rep.primaryAction || { type: 'ask-pledge' };
            var template = generateTemplate(rep, pledgeAction, userName, userCity);
            var fullText = 'Subject: ' + template.subject + '\n\n' + template.body;

            var sendBtn;
            if (contact.method === 'email') {
                sendBtn = document.createElement('a');
                sendBtn.href = 'mailto:' + rep.email + '?subject=' + encodeURIComponent(template.subject) + '&body=' + encodeURIComponent(template.body);
                sendBtn.className = 'btn btn-primary';
                sendBtn.style.cssText = 'text-decoration:none;display:inline-block;';
                sendBtn.textContent = 'Open Email to ' + rep.name.split(' ').pop();
                sendBtn.target = '_blank';
            } else if (contact.method === 'contact_form') {
                sendBtn = document.createElement('button');
                sendBtn.className = 'btn btn-primary';
                sendBtn.textContent = 'Open Contact Form for ' + rep.name.split(' ').pop();
            } else if (contact.method === 'fec') {
                sendBtn = document.createElement('button');
                sendBtn.className = 'btn btn-outline';
                sendBtn.style.cssText = 'border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
                sendBtn.textContent = 'Find Contact on FEC.gov';
            } else {
                sendBtn = document.createElement('button');
                sendBtn.className = 'btn btn-outline';
                sendBtn.style.cssText = 'border-color:rgba(255,255,255,0.3);color:rgba(255,255,255,0.6);';
                sendBtn.textContent = 'No Contact Info';
                sendBtn.disabled = true;
            }

            sendBtn.addEventListener('click', function() {
                // Copy to clipboard
                navigator.clipboard.writeText(fullText).catch(function(err) { console.warn('SAFE Action:', err.message || err); });
                logContact(rep, 'email');

                if (contact.method === 'email') {
                    showToast('Email template copied & opening Gmail for ' + rep.name);
                } else if (contact.method === 'contact_form') {
                    window.open(contact.url, '_blank');
                    showToast('Template copied! Paste it into ' + rep.name.split(' ').pop() + "'s contact form.");
                } else if (contact.method === 'fec') {
                    window.open(contact.url, '_blank');
                    showToast('Template copied! Check FEC page for contact info.');
                } else {
                    showToast('Template copied to clipboard!');
                }
                trackAction('email');

                // Hide skip button
                if (skipBtn) skipBtn.style.display = 'none';

                // Only add "Next Rep" button and template preview once
                if (!btnArea.querySelector('.next-rep-btn')) {
                    var nextBtn = document.createElement('button');
                    nextBtn.className = 'btn btn-primary next-rep-btn';
                    nextBtn.textContent = idx + 1 < total ? 'Next Rep (' + (total - idx - 1) + ' remaining)' : 'Finish';
                    nextBtn.addEventListener('click', function() {
                        idx++;
                        showStep();
                    });
                    btnArea.appendChild(nextBtn);

                    // Show copyable template preview below buttons
                    var templatePreview = document.createElement('div');
                    templatePreview.style.cssText = 'width:100%;flex-basis:100%;order:10;margin-top:8px;';
                    var toggleBtn = document.createElement('button');
                    toggleBtn.style.cssText = 'background:none;border:none;color:rgba(255,255,255,0.7);font-size:0.8rem;cursor:pointer;padding:0;text-decoration:underline;';
                    toggleBtn.textContent = '\u2709 Show email template (copied to clipboard)';
                    var previewBox = document.createElement('div');
                    previewBox.style.cssText = 'display:none;margin-top:6px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:12px;max-height:200px;overflow-y:auto;';
                    var previewText = document.createElement('pre');
                    previewText.style.cssText = 'white-space:pre-wrap;word-wrap:break-word;font-size:0.8rem;color:rgba(255,255,255,0.85);margin:0;font-family:inherit;';
                    previewText.textContent = fullText;
                    var copyAgainBtn = document.createElement('button');
                    copyAgainBtn.className = 'btn btn-outline';
                    copyAgainBtn.style.cssText = 'margin-top:8px;font-size:0.75rem;padding:4px 12px;border-color:rgba(255,255,255,0.3);color:rgba(255,255,255,0.8);';
                    copyAgainBtn.textContent = 'Copy Again';
                    copyAgainBtn.addEventListener('click', function() {
                        navigator.clipboard.writeText(fullText).catch(function(err) { console.warn('SAFE Action:', err.message || err); });
                        copyAgainBtn.textContent = '\u2713 Copied!';
                        setTimeout(function() { copyAgainBtn.textContent = 'Copy Again'; }, 2000);
                    });
                    previewBox.appendChild(previewText);
                    previewBox.appendChild(copyAgainBtn);
                    toggleBtn.addEventListener('click', function() {
                        if (previewBox.style.display === 'none') {
                            previewBox.style.display = '';
                            toggleBtn.textContent = '\u2709 Hide email template';
                        } else {
                            previewBox.style.display = 'none';
                            toggleBtn.textContent = '\u2709 Show email template (copied to clipboard)';
                        }
                    });
                    templatePreview.appendChild(toggleBtn);
                    templatePreview.appendChild(previewBox);
                    btnArea.appendChild(templatePreview);
                }
            });
            btnArea.appendChild(sendBtn);

            var skipBtn = document.createElement('button');
            skipBtn.className = 'btn btn-outline';
            skipBtn.style.cssText = 'border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
            skipBtn.textContent = 'Skip';
            skipBtn.addEventListener('click', function() {
                idx++;
                showStep();
            });
            btnArea.appendChild(skipBtn);

            } // end renderEmailButton
        }

        showStep();
    }

    function generateCandidateTemplate(candidate, userName, userCity) {
        var lastName = candidate.name.split(' ').pop();
        var vars = {
            name: userName || '',
            city: userCity || '',
            state: candidate.state || '',
            title: candidate.office.includes('Senate') ? 'Senator' : 'Representative',
            lastName: lastName,
            fullName: candidate.name,
            pledgeUrl: 'https://scienceandfreedom.com/pledge'
        };

        var hasLibrary = typeof EMAIL_TEMPLATES !== 'undefined' && typeof getTemplateIndex === 'function' && typeof fillTemplate === 'function';
        if (hasLibrary && EMAIL_TEMPLATES.candidate) {
            var si = getTemplateIndex(candidate.name, EMAIL_TEMPLATES.candidate.subjects.length, 'cand-subj');
            var bi = getTemplateIndex(candidate.name, EMAIL_TEMPLATES.candidate.bodies.length, 'cand-body');
            return {
                subject: fillTemplate(EMAIL_TEMPLATES.candidate.subjects[si], vars),
                body: fillTemplate(EMAIL_TEMPLATES.candidate.bodies[bi], vars)
            };
        }
        // Fallback
        return {
            subject: 'Will you take the SAFE Action pledge on science?',
            body: 'Dear ' + candidate.name + ',\n\nI am writing as a concerned voter in your district to ask you to take the SAFE Action pledge on science and public health policy.\n\nThe SAFE Action pledge commits candidates and elected officials to supporting evidence-based public health measures, including maintaining strong vaccination programs that protect our communities.\n\nTaking this pledge shows voters that you prioritize science and public health. You can take the pledge at: https://scienceandfreedom.com/pledge\n\nThank you for your time.\n\nSincerely,' + (userName ? '\n' + userName : '') + '\n' + (userCity || candidate.state || '')
        };
    }

    function emailAllCandidates(candidates, bar) {
        var idx = 0;
        var total = candidates.length;
        var userName = getUserName();
        var userCity = getUserCity();

        bar.textContent = '';
        var inner = document.createElement('div');
        inner.className = 'email-all-inner';
        bar.appendChild(inner);

        var progressHeader = document.createElement('div');
        progressHeader.className = 'email-all-text';
        inner.appendChild(progressHeader);

        var repInfo = document.createElement('div');
        repInfo.style.cssText = 'background:rgba(255,255,255,0.1);border-radius:8px;padding:12px 16px;margin:8px 0;';
        inner.appendChild(repInfo);

        var btnArea = document.createElement('div');
        btnArea.style.cssText = 'display:flex;gap:10px;align-items:center;flex-wrap:wrap;';
        inner.appendChild(btnArea);

        function showCandStep() {
            if (idx >= total) {
                progressHeader.innerHTML = '<strong>All Done!</strong><p>You contacted all ' + total + ' candidates. Thank you for going the extra mile!</p>';
                repInfo.style.display = 'none';
                btnArea.textContent = '';
                // PWA install prompt for engaged users
                if (typeof createPostActionInstallBtn === 'function') {
                    var pwaBtn = createPostActionInstallBtn();
                    if (pwaBtn) btnArea.appendChild(pwaBtn);
                }
                var doneBtn = document.createElement('button');
                doneBtn.className = 'btn btn-primary';
                doneBtn.textContent = 'Finished';
                doneBtn.addEventListener('click', function() {
                    buildEmailAllHero(_currentReps);
                });
                btnArea.appendChild(doneBtn);
                return;
            }

            var cand = candidates[idx];
            progressHeader.innerHTML = '<strong>Candidate ' + (idx + 1) + ' of ' + total + '</strong>';

            var partyLabel = cand.party === 'R' ? 'Republican' : cand.party === 'D' ? 'Democrat' : cand.partyFull || cand.party;
            repInfo.style.display = '';
            repInfo.innerHTML = '';
            var candName = document.createElement('div');
            candName.style.cssText = 'font-weight:700;font-size:1.05rem;color:#fff;';
            candName.textContent = cand.name;
            repInfo.appendChild(candName);
            var candDetail = document.createElement('div');
            candDetail.style.cssText = 'font-size:0.85rem;color:rgba(255,255,255,0.75);margin-top:2px;';
            candDetail.textContent = partyLabel + ' - ' + cand.office;
            repInfo.appendChild(candDetail);

            btnArea.textContent = '';

            var template = generateCandidateTemplate(cand, userName, userCity);
            var fullText = 'Subject: ' + template.subject + '\n\n' + template.body;

            // Determine contact method
            var contactUrl = cand.contactForm || '';
            if (!contactUrl && cand.website) {
                contactUrl = cand.website.replace(/\/+$/, '') + '/contact';
            }

            var sendBtn;
            if (cand.email) {
                sendBtn = document.createElement('a');
                sendBtn.href = 'mailto:' + cand.email + '?subject=' + encodeURIComponent(template.subject) + '&body=' + encodeURIComponent(template.body);
                sendBtn.className = 'btn btn-primary';
                sendBtn.style.cssText = 'text-decoration:none;display:inline-block;';
                sendBtn.textContent = 'Open Email to ' + cand.name.split(' ').pop();
                sendBtn.target = '_blank';
            } else {
                sendBtn = document.createElement('button');
                sendBtn.className = 'btn btn-primary';
                sendBtn.textContent = 'Copy Pledge Template';
            }

            sendBtn.addEventListener('click', function() {
                navigator.clipboard.writeText(fullText).catch(function(err) { console.warn('SAFE Action:', err.message || err); });

                if (cand.email) {
                    showToast('Email opening for ' + cand.name);
                } else if (contactUrl) {
                    window.open(contactUrl, '_blank');
                    showToast('Template copied! Paste it into the contact form.');
                } else {
                    showToast('Pledge template copied to clipboard! Search for ' + cand.name + "'s website to send it.");
                }
                trackAction('email');

                if (skipBtn) skipBtn.style.display = 'none';

                if (!btnArea.querySelector('.next-rep-btn')) {
                    var nextBtn = document.createElement('button');
                    nextBtn.className = 'btn btn-primary next-rep-btn';
                    nextBtn.textContent = idx + 1 < total ? 'Next Candidate (' + (total - idx - 1) + ' remaining)' : 'Finish';
                    nextBtn.addEventListener('click', function() {
                        idx++;
                        showCandStep();
                    });
                    btnArea.appendChild(nextBtn);
                }
            });
            btnArea.appendChild(sendBtn);

            var skipBtn = document.createElement('button');
            skipBtn.className = 'btn btn-outline';
            skipBtn.style.cssText = 'border-color:rgba(255,255,255,0.4);color:rgba(255,255,255,0.8);';
            skipBtn.textContent = 'Skip';
            skipBtn.addEventListener('click', function() {
                idx++;
                showCandStep();
            });
            btnArea.appendChild(skipBtn);
        }

        showCandStep();
    }

    function renderStats(reps) {
        let totalBills = 0;
        let noPledge = 0;

        reps.forEach(rep => {
            if (rep.bills) {
                totalBills += rep.bills.filter(b => b.billType === 'anti').length;
            }
            noPledge++;
        });

        const el = (id, val) => {
            const e = document.getElementById(id);
            if (e) e.textContent = val;
        };
        el('stat-active-bills', totalBills);
        el('stat-reps-found', reps.length);
        el('stat-no-pledge', noPledge);
    }

    function buildRepCard(rep, idx, allReps) {
        const card = document.createElement('div');
        const action = rep.primaryAction || {};
        const actionClass = action.type === 'oppose-bill' ? 'action-oppose' : 'action-pledge';
        card.className = `rep-hub-card ${actionClass}`;

        // ── Header ──
        const header = document.createElement('div');
        header.className = 'rep-hub-card-header';

        // Photo
        const photoWrap = document.createElement('div');
        photoWrap.className = 'rep-hub-photo-wrap';
        if (rep.photoUrl) {
            const img = document.createElement('img');
            img.src = rep.photoUrl;
            img.alt = rep.name;
            img.className = 'rep-hub-photo';
            img.onerror = function() { this.style.display = 'none'; this.nextElementSibling.style.display = 'flex'; };
            photoWrap.appendChild(img);
            const placeholder = document.createElement('div');
            placeholder.className = 'rep-hub-photo-placeholder';
            placeholder.style.display = 'none';
            placeholder.textContent = rep.name.charAt(0);
            photoWrap.appendChild(placeholder);
        } else {
            const placeholder = document.createElement('div');
            placeholder.className = 'rep-hub-photo-placeholder';
            placeholder.textContent = rep.name.charAt(0);
            photoWrap.appendChild(placeholder);
        }
        header.appendChild(photoWrap);

        // Info block
        const info = document.createElement('div');
        info.className = 'rep-hub-info';
        const nameEl = document.createElement('h3');
        nameEl.className = 'rep-hub-name';
        nameEl.textContent = rep.name;
        info.appendChild(nameEl);

        const party = rep.party || '?';
        const partyBadge = document.createElement('span');
        partyBadge.className = `rep-hub-party badge ${party === 'R' ? 'party-r' : party === 'D' ? 'party-d' : 'party-i'}`;
        partyBadge.textContent = party === 'R' ? 'Republican' : party === 'D' ? 'Democrat' : rep.partyFull || party;
        info.appendChild(partyBadge);

        const officeEl = document.createElement('span');
        officeEl.className = 'rep-hub-office';
        officeEl.textContent = rep.office;
        info.appendChild(officeEl);
        header.appendChild(info);

                card.appendChild(header);

        // ── Primary Action Bar ──
        const actionBar = document.createElement('div');
        actionBar.className = 'rep-hub-action';

        const iconSpan = document.createElement('span');
        iconSpan.className = 'action-icon';
        iconSpan.innerHTML = action.type === 'oppose-bill' ? '&#9888;' : '&#9733;';
        actionBar.appendChild(iconSpan);

        const actionContent = document.createElement('div');
        actionContent.className = 'action-content';
        const actionStrong = document.createElement('strong');
        actionStrong.textContent = action.label || 'Take Action';
        actionContent.appendChild(actionStrong);
        const actionDesc = document.createElement('p');
        actionDesc.textContent = action.description || '';
        actionContent.appendChild(actionDesc);
        actionBar.appendChild(actionContent);

        var repContact = getBestContactMethod(rep);
        var emailBtn;
        if (repContact.method === 'email') {
            var repAction = rep.primaryAction || {};
            var repTemplate = generateTemplate(rep, repAction, getUserName(), getUserCity());
            emailBtn = document.createElement('a');
            emailBtn.href = 'mailto:' + rep.email + '?subject=' + encodeURIComponent(repTemplate.subject) + '&body=' + encodeURIComponent(repTemplate.body);
            emailBtn.target = '_blank';
            emailBtn.style.textDecoration = 'none';
            emailBtn.textContent = 'Email';
            emailBtn.addEventListener('click', function() {
                var ft = 'Subject: ' + repTemplate.subject + '\n\n' + repTemplate.body;
                navigator.clipboard.writeText(ft).catch(function(err) { console.warn('SAFE Action:', err.message || err); });
                logContact(rep, 'email');
                showToast('Email template copied & opening for ' + rep.name);
                trackAction('email');
            });
        } else if (repContact.method === 'contact_form') {
            emailBtn = document.createElement('button');
            emailBtn.textContent = 'Contact Form';
            emailBtn.addEventListener('click', function() { openEmailAction(rep); });
        } else if (repContact.method === 'fec') {
            emailBtn = document.createElement('a');
            emailBtn.href = repContact.url;
            emailBtn.target = '_blank';
            emailBtn.style.textDecoration = 'none';
            emailBtn.textContent = 'FEC Page';
        } else {
            emailBtn = document.createElement('button');
            emailBtn.textContent = 'No Contact';
            emailBtn.disabled = true;
            emailBtn.style.opacity = '0.5';
        }
        emailBtn.className = 'btn btn-primary rep-hub-email-btn';
        actionBar.appendChild(emailBtn);

        if (rep.phone) {
            const callBtn = document.createElement('button');
            callBtn.className = 'btn btn-outline rep-hub-call-btn';
            callBtn.innerHTML = '&#128222; Call';
            callBtn.addEventListener('click', () => window.open('tel:' + rep.phone));
            actionBar.appendChild(callBtn);
        }
        card.appendChild(actionBar);

        // ── Expand Button ──
        const expandBtn = document.createElement('button');
        expandBtn.className = 'rep-hub-expand-btn';
        expandBtn.textContent = 'Show Details';
        card.appendChild(expandBtn);

        // ── Detail Section (hidden) ──
        const detail = document.createElement('div');
        detail.className = 'rep-hub-detail';
        detail.style.display = 'none';


        
        // Bills
        if (rep.bills && rep.bills.length > 0) {
            const billsDiv = document.createElement('div');
            billsDiv.className = 'rep-hub-bills';
            const billsTitle = document.createElement('h4');
            billsTitle.textContent = `Active Bills in Their Jurisdiction (${rep.bills.length})`;
            billsDiv.appendChild(billsTitle);
            rep.bills.slice(0, 5).forEach(b => {
                const item = document.createElement('div');
                item.className = 'rep-bill-item';
                const badge = document.createElement('span');
                badge.className = `badge ${b.billType === 'anti' ? 'badge-anti' : b.billType === 'pro' ? 'badge-pro' : 'badge-monitor'}`;
                badge.textContent = b.billType === 'anti' ? 'Oppose' : b.billType === 'pro' ? 'Support' : 'Monitor';
                item.appendChild(badge);
                const num = document.createElement('strong');
                num.textContent = ' ' + b.billNumber;
                item.appendChild(num);
                const titleText = document.createTextNode(' - ' + (b.title.length > 80 ? b.title.substring(0, 80) + '...' : b.title));
                item.appendChild(titleText);
                const statusSpan = document.createElement('span');
                statusSpan.className = 'rep-bill-status';
                statusSpan.textContent = b.status;
                item.appendChild(statusSpan);
                billsDiv.appendChild(item);
            });
            detail.appendChild(billsDiv);
        }

        // Candidates running for this seat
        if (rep.candidates && rep.candidates.length > 0) {
            var candSection = document.createElement('div');
            candSection.className = 'rep-hub-candidates';

            var candTitle = document.createElement('h4');
            candTitle.textContent = 'Ask Candidates to Take the Pledge';
            candSection.appendChild(candTitle);

            var candSubtext = document.createElement('p');
            candSubtext.className = 'cand-subtext';
            candSubtext.textContent = 'These candidates are running for this seat. Ask each one to take the SAFE Action pledge.';
            candSection.appendChild(candSubtext);

            var candList = document.createElement('div');
            candList.className = 'candidate-card-list';

            rep.candidates.forEach(function(c) {
                var card = document.createElement('div');
                card.className = 'candidate-action-card';
                var partyLetter = (c.party || '?').charAt(0).toUpperCase();
                if (partyLetter === 'R') card.classList.add('party-r');
                else if (partyLetter === 'D') card.classList.add('party-d');
                else card.classList.add('party-i');

                // Candidate header row
                var cardHeader = document.createElement('div');
                cardHeader.className = 'cand-card-header';
                var nameSpan = document.createElement('span');
                nameSpan.className = 'cand-card-name';
                nameSpan.textContent = c.name;
                cardHeader.appendChild(nameSpan);
                var partyBadge = document.createElement('span');
                partyBadge.className = 'cand-card-party';
                partyBadge.textContent = c.party || '?';
                cardHeader.appendChild(partyBadge);
                card.appendChild(cardHeader);

                var seatLabel = document.createElement('div');
                seatLabel.className = 'cand-card-seat';
                seatLabel.textContent = 'Running for: ' + rep.office;
                card.appendChild(seatLabel);

                // Get Template button
                var templateBtn = document.createElement('button');
                templateBtn.className = 'btn btn-sm cand-template-btn';
                templateBtn.textContent = 'Get Pledge Template';
                card.appendChild(templateBtn);

                // Template panel (hidden initially)
                var templatePanel = document.createElement('div');
                templatePanel.className = 'cand-template-panel';
                templatePanel.style.display = 'none';

                var candLastName = c.name.split(' ').pop();
                var candFullParty = c.party === 'R' ? 'Republican' : c.party === 'D' ? 'Democrat' : c.party || '';

                var emailSubject = 'Will you take the SAFE Action pledge on science and public health?';
                var emailBody = 'Dear ' + c.name + ',\n\n' +
                    'I am writing to ask you to take the SAFE Action pledge on science and public health policy.\n\n' +
                    'As a candidate for ' + rep.office + ', your position on science-based public health policy matters to voters in our community. The SAFE Action pledge commits candidates to supporting evidence-based public health measures, including maintaining strong vaccination programs.\n\n' +
                    'Taking this pledge shows voters that you prioritize science and public health. You can take the pledge at: https://scienceandfreedom.com/pledge\n\n' +
                    'Thank you for your time.\n\n' +
                    'Sincerely,' + (getUserName() ? '\n' + getUserName() : '') + '\n' + (getUserCity() ? getUserCity() + ', ' + rep.state : rep.state);

                // Subject line
                var subjLabel = document.createElement('div');
                subjLabel.className = 'template-field-label';
                subjLabel.textContent = 'Subject:';
                templatePanel.appendChild(subjLabel);
                var subjBox = document.createElement('div');
                subjBox.className = 'template-content template-subject';
                subjBox.textContent = emailSubject;
                templatePanel.appendChild(subjBox);

                // Body
                var bodyLabel = document.createElement('div');
                bodyLabel.className = 'template-field-label';
                bodyLabel.textContent = 'Email Body:';
                templatePanel.appendChild(bodyLabel);
                var bodyBox = document.createElement('pre');
                bodyBox.className = 'template-content template-body';
                bodyBox.textContent = emailBody;
                templatePanel.appendChild(bodyBox);

                // Copy button
                var copyBtn = document.createElement('button');
                copyBtn.className = 'btn btn-sm btn-outline cand-copy-btn';
                copyBtn.textContent = 'Copy Email';
                copyBtn.addEventListener('click', function() {
                    var fullText = 'Subject: ' + emailSubject + '\n\n' + emailBody;
                    navigator.clipboard.writeText(fullText).then(function() {
                        copyBtn.textContent = 'Copied!';
                        setTimeout(function() { copyBtn.textContent = 'Copy Email'; }, 2000);
                    }).catch(function() {
                        // Fallback
                        var ta = document.createElement('textarea');
                        ta.value = fullText;
                        document.body.appendChild(ta);
                        ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        copyBtn.textContent = 'Copied!';
                        setTimeout(function() { copyBtn.textContent = 'Copy Email'; }, 2000);
                    });
                });
                templatePanel.appendChild(copyBtn);

                // FEC lookup link if available
                if (c.fecId) {
                    var fecLink = document.createElement('a');
                    fecLink.href = 'https://www.fec.gov/data/candidate/' + c.fecId + '/';
                    fecLink.target = '_blank';
                    fecLink.rel = 'noopener';
                    fecLink.className = 'cand-fec-link';
                    fecLink.textContent = 'Find contact info on FEC.gov \u2192';
                    templatePanel.appendChild(fecLink);
                }

                card.appendChild(templatePanel);

                // Toggle template visibility
                templateBtn.addEventListener('click', function() {
                    var isVisible = templatePanel.style.display !== 'none';
                    templatePanel.style.display = isVisible ? 'none' : '';
                    templateBtn.textContent = isVisible ? 'Get Pledge Template' : 'Hide Template';
                });

                candList.appendChild(card);
            });

            candSection.appendChild(candList);
            detail.appendChild(candSection);
        }

        // Contact info
        if (rep.phone || rep.email) {
            const contactDiv = document.createElement('div');
            contactDiv.className = 'rep-hub-contact';
            const contactTitle = document.createElement('h4');
            contactTitle.textContent = 'Contact Information';
            contactDiv.appendChild(contactTitle);
            if (rep.phone) {
                const phoneP = document.createElement('p');
                phoneP.innerHTML = '<strong>Phone:</strong> ';
                const phoneLink = document.createElement('a');
                phoneLink.href = 'tel:' + rep.phone;
                phoneLink.textContent = rep.phone;
                phoneP.appendChild(phoneLink);
                contactDiv.appendChild(phoneP);
            }
            if (rep.email) {
                const emailP = document.createElement('p');
                emailP.innerHTML = '<strong>Email:</strong> ';
                const emailLink = document.createElement('a');
                emailLink.href = 'mailto:' + rep.email;
                emailLink.textContent = rep.email;
                emailP.appendChild(emailLink);
                contactDiv.appendChild(emailP);
            }
            detail.appendChild(contactDiv);
        }

        // Email template - with personalization inputs
        const templateDiv = document.createElement('div');
        templateDiv.className = 'rep-hub-template';
        const templateTitle = document.createElement('h4');
        templateTitle.textContent = 'Email Template';
        templateDiv.appendChild(templateTitle);

        // Name + City inputs
        const personalizeRow = document.createElement('div');
        personalizeRow.className = 'template-personalize';
        personalizeRow.style.cssText = 'display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap;';

        const nameGroup = document.createElement('div');
        nameGroup.style.cssText = 'flex:1;min-width:150px;';
        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Your Name';
        nameLabel.style.cssText = 'display:block;font-size:0.8rem;font-weight:600;color:#4A4A6A;margin-bottom:4px;';
        nameGroup.appendChild(nameLabel);
        const nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.placeholder = 'Enter your name';
        nameInput.value = getUserName();
        nameInput.style.cssText = 'width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:6px;font-size:0.9rem;';
        nameGroup.appendChild(nameInput);
        personalizeRow.appendChild(nameGroup);

        const cityGroup = document.createElement('div');
        cityGroup.style.cssText = 'flex:1;min-width:150px;';
        const cityLabel = document.createElement('label');
        cityLabel.textContent = 'Your City';
        cityLabel.style.cssText = 'display:block;font-size:0.8rem;font-weight:600;color:#4A4A6A;margin-bottom:4px;';
        cityGroup.appendChild(cityLabel);
        const cityInput = document.createElement('input');
        cityInput.type = 'text';
        cityInput.placeholder = 'Enter your city';
        cityInput.value = getUserCity();
        cityInput.style.cssText = 'width:100%;padding:8px 12px;border:1px solid #D1D5DB;border-radius:6px;font-size:0.9rem;';
        cityGroup.appendChild(cityInput);
        personalizeRow.appendChild(cityGroup);

        templateDiv.appendChild(personalizeRow);

        // Generate template with user info
        const template = generateTemplate(rep, action, nameInput.value, cityInput.value);

        const subjectField = document.createElement('div');
        subjectField.className = 'template-field';
        const subjectLabel = document.createElement('label');
        subjectLabel.textContent = 'Subject';
        subjectField.appendChild(subjectLabel);
        const subjectInput = document.createElement('input');
        subjectInput.type = 'text';
        subjectInput.value = template.subject;
        subjectField.appendChild(subjectInput);
        templateDiv.appendChild(subjectField);

        const bodyField = document.createElement('div');
        bodyField.className = 'template-field';
        const bodyLabel = document.createElement('label');
        bodyLabel.textContent = 'Body';
        bodyField.appendChild(bodyLabel);
        const bodyTextarea = document.createElement('textarea');
        bodyTextarea.rows = 8;
        bodyTextarea.value = template.body;
        bodyField.appendChild(bodyTextarea);
        templateDiv.appendChild(bodyField);

        // Live-update template when name/city change
        function refreshTemplate() {
            const n = nameInput.value;
            const c = cityInput.value;
            saveUserInfo(n, c);
            const updated = generateTemplate(rep, action, n, c);
            subjectInput.value = updated.subject;
            bodyTextarea.value = updated.body;
            // Update phone script too if present
            const phoneTA = detail.querySelector('.phone-script-textarea');
            if (phoneTA) phoneTA.value = generatePhoneScript(rep, action, n, c);
        }
        nameInput.addEventListener('input', refreshTemplate);
        cityInput.addEventListener('input', refreshTemplate);

        const templateActions = document.createElement('div');
        templateActions.className = 'template-actions';
        const copyBtn = document.createElement('button');
        copyBtn.className = 'btn btn-primary';
        copyBtn.textContent = 'Copy to Clipboard';
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(bodyTextarea.value).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy to Clipboard'; }, 2000);
            });
        });
        templateActions.appendChild(copyBtn);
        if (rep.email) {
            const mailtoLink = document.createElement('a');
            mailtoLink.className = 'btn btn-outline';
            mailtoLink.href = `mailto:${rep.email}?subject=${encodeURIComponent(subjectInput.value)}&body=${encodeURIComponent(bodyTextarea.value)}`;
            // Update mailto when clicking (use current values)
            mailtoLink.addEventListener('click', (e) => {
                mailtoLink.href = `mailto:${rep.email}?subject=${encodeURIComponent(subjectInput.value)}&body=${encodeURIComponent(bodyTextarea.value)}`;
            });
            mailtoLink.textContent = 'Open in Email App';
            templateActions.appendChild(mailtoLink);
        }
        templateDiv.appendChild(templateActions);
        detail.appendChild(templateDiv);

        // Phone script
        if (rep.phone) {
            const phoneDiv = document.createElement('div');
            phoneDiv.className = 'rep-hub-template';
            const phoneTitle = document.createElement('h4');
            phoneTitle.textContent = 'Phone Script';
            phoneDiv.appendChild(phoneTitle);
            const phoneTextarea = document.createElement('textarea');
            phoneTextarea.rows = 6;
            phoneTextarea.className = 'phone-script-textarea';
            phoneTextarea.value = generatePhoneScript(rep, action, nameInput.value, cityInput.value);
            phoneDiv.appendChild(phoneTextarea);
            const phoneActions = document.createElement('div');
            phoneActions.className = 'template-actions';
            const phoneCopyBtn = document.createElement('button');
            phoneCopyBtn.className = 'btn btn-primary';
            phoneCopyBtn.textContent = 'Copy Script';
            phoneCopyBtn.addEventListener('click', () => {
                navigator.clipboard.writeText(phoneTextarea.value).then(() => {
                    phoneCopyBtn.textContent = 'Copied!';
                    setTimeout(() => { phoneCopyBtn.textContent = 'Copy Script'; }, 2000);
                });
            });
            phoneActions.appendChild(phoneCopyBtn);
            const phoneLink = document.createElement('a');
            phoneLink.className = 'btn btn-outline';
            phoneLink.href = 'tel:' + rep.phone;
            phoneLink.innerHTML = '&#128222; Open in Phone App';
            phoneActions.appendChild(phoneLink);
            phoneDiv.appendChild(phoneActions);
            detail.appendChild(phoneDiv);
        }

        card.appendChild(detail);

        // Expand/collapse toggle
        expandBtn.addEventListener('click', () => {
            const isOpen = detail.style.display !== 'none';
            detail.style.display = isOpen ? 'none' : '';
            expandBtn.textContent = isOpen ? 'Show Details' : 'Hide Details';
        });

        return card;
    }

    // Randomized subject lines so mass emails don't look like spam
    function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    // Legacy inline subjects as fallback if email-templates.js not loaded
    var _legacyPledgeSubjects = [
        'Will you take the SAFE Action pledge on science and public health?',
        'A constituent request: take the SAFE Action pledge',
        'Please stand with science - take the SAFE Action pledge',
    ];
    var _legacyOpposeSubjects = [
        'Please OPPOSE {bill} - {title}',
        'Vote NO on {bill}: protect public health',
        'Constituent request: oppose {bill}',
    ];

    function generateTemplate(rep, action, userName, userCity) {
        var title = rep.office.includes('Senate') ? 'Senator' : 'Representative';
        var lastName = rep.name.split(' ').pop();
        var vars = {
            name: userName || '',
            city: userCity || '',
            state: rep.state || '',
            title: title,
            lastName: lastName,
            fullName: rep.name,
            pledgeUrl: 'https://scienceandfreedom.com/pledge',
            billNumber: '',
            billTitle: ''
        };
        // Avoid duplicating state if user already typed "City, ST"
        var cityStr = userCity || '';
        var stateAbbr = rep.state || '';
        var cityHasState = cityStr.match(/,\s*[A-Z]{2}\s*$/);
        var signoff = (userName ? userName + '\n' : '') + (cityStr ? (cityHasState ? cityStr : cityStr + ', ' + stateAbbr) : stateAbbr);

        // Use template library if available
        var hasLibrary = typeof EMAIL_TEMPLATES !== 'undefined' && typeof getTemplateIndex === 'function' && typeof fillTemplate === 'function';

        if (action.type === 'oppose-bill' && action.bill) {
            vars.billNumber = action.bill.billNumber;
            vars.billTitle = action.bill.title.length > 60 ? action.bill.title.substring(0, 60) + '...' : action.bill.title;

            if (hasLibrary && EMAIL_TEMPLATES.oppose) {
                var si = getTemplateIndex(rep.name, EMAIL_TEMPLATES.oppose.subjects.length, 'oppose-subj');
                var bi = getTemplateIndex(rep.name, EMAIL_TEMPLATES.oppose.bodies.length, 'oppose-body');
                return {
                    subject: fillTemplate(EMAIL_TEMPLATES.oppose.subjects[si], vars),
                    body: fillTemplate(EMAIL_TEMPLATES.oppose.bodies[bi], vars)
                };
            }
            // Fallback
            var subj = pickRandom(_legacyOpposeSubjects)
                .replace(/\{bill\}/g, action.bill.billNumber)
                .replace(/\{title\}/g, action.bill.title.substring(0, 60));
            return {
                subject: subj,
                body: 'Dear ' + title + ' ' + lastName + ',\n\nI am writing as a concerned constituent to urge you to OPPOSE ' + action.bill.billNumber + ', "' + action.bill.title + '".\n\nThis legislation undermines public health protections that keep our communities safe. As your constituent, I urge you to stand with science and evidence-based policy by voting NO on this bill.\n\nThank you for your time and service.\n\nSincerely,\n' + signoff
            };
        }

        // Pledge request
        if (hasLibrary && EMAIL_TEMPLATES.pledge) {
            var si2 = getTemplateIndex(rep.name, EMAIL_TEMPLATES.pledge.subjects.length, 'pledge-subj');
            var bi2 = getTemplateIndex(rep.name, EMAIL_TEMPLATES.pledge.bodies.length, 'pledge-body');
            return {
                subject: fillTemplate(EMAIL_TEMPLATES.pledge.subjects[si2], vars),
                body: fillTemplate(EMAIL_TEMPLATES.pledge.bodies[bi2], vars)
            };
        }
        // Fallback
        return {
            subject: pickRandom(_legacyPledgeSubjects),
            body: 'Dear ' + title + ' ' + lastName + ',\n\nI am writing as a concerned constituent to ask you to take the SAFE Action pledge on science and public health policy.\n\nThe SAFE Action pledge commits elected officials to supporting evidence-based public health measures, including maintaining strong vaccination programs that protect our communities.\n\nTaking this pledge shows your constituents that you prioritize science and public health. You can take the pledge at: https://scienceandfreedom.com/pledge\n\nThank you for your time and service.\n\nSincerely,\n' + signoff
        };
    }

    function generatePhoneScript(rep, action, userName, userCity) {
        const title = rep.office.includes('Senate') ? 'Senator' : 'Representative';
        const lastName = rep.name.split(' ').pop();

        if (action.type === 'oppose-bill' && action.bill) {
            return `Hello, ${userName ? 'my name is ' + userName + ' and ' : ''}I'm a constituent from ${userCity || rep.state}.

I'm calling to ask ${title} ${lastName} to please OPPOSE ${action.bill.billNumber}, "${action.bill.title}".

This bill would weaken important public health protections and I believe it puts our community at risk. I urge the ${title} to vote NO on this bill.

Thank you for taking my call.`;
        }

        return `Hello, ${userName ? 'my name is ' + userName + ' and ' : ''}I'm a constituent from ${userCity || rep.state}.

I'm calling to ask ${title} ${lastName} to take the SAFE Action pledge on science and public health.

The pledge commits officials to supporting evidence-based public health measures, including strong vaccination programs. I believe this is important for our community.

Thank you for taking my call.`;
    }

    function openEmailAction(rep) {
        var action = rep.primaryAction || {};
        var template = generateTemplate(rep, action, getUserName(), getUserCity());
        var fullText = 'Subject: ' + template.subject + '\n\n' + template.body;

        // Always copy to clipboard
        navigator.clipboard.writeText(fullText).catch(function(err) { console.warn('SAFE Action:', err.message || err); });

        if (rep.email) {
            var mailtoUrl = 'mailto:' + rep.email + '?subject=' + encodeURIComponent(template.subject) + '&body=' + encodeURIComponent(template.body);
            var mailLink = document.createElement('a');
            mailLink.href = mailtoUrl;
            mailLink.style.display = 'none';
            document.body.appendChild(mailLink);
            mailLink.click();
            document.body.removeChild(mailLink);
            showToast('Email template copied & email opening for ' + rep.name + '...');
        } else {
            // Build contact form URL: prefer contactForm, then try /contact on website
            var url = rep.contactForm || '';
            if (!url && rep.website) {
                url = rep.website.replace(/\/+$/, '') + '/contact';
            }
            if (url) {
                window.open(url, '_blank');
                showToast('Template copied! Paste it into ' + rep.name.split(' ').pop() + "'s contact form.");
            } else {
                showToast('Template copied to clipboard!');
            }
        }
        trackAction('email');
    }

    function showToast(message) {
        var existing = document.querySelector('.safe-toast');
        if (existing) existing.remove();
        var toast = document.createElement('div');
        toast.className = 'safe-toast';
        toast.textContent = message;
        document.body.appendChild(toast);
        setTimeout(function() { toast.classList.add('safe-toast-show'); }, 10);
        setTimeout(function() {
            toast.classList.remove('safe-toast-show');
            setTimeout(function() { toast.remove(); }, 300);
        }, 4000);
    }

    function trackAction(type) {
        // Gather metadata for live dashboard
        var meta = { type: type };
        try {
            var addrData = JSON.parse(localStorage.getItem('safe_my_address'));
            if (addrData && addrData.normalizedAddress) {
                meta.city = addrData.normalizedAddress.city || '';
                meta.state = addrData.normalizedAddress.state || '';
            }
        } catch (e) {}
        // Current bill info
        if (window._bill) {
            meta.billId = window._bill.billNumber || '';
            meta.billTitle = window._bill.title || '';
        }

        try {
            // Use the same localStorage key as main.js so homepage counters update
            var BASE_ACTIONS = SAFE_CONFIG.BASE_ACTIONS;
            var BASE_EMAILS = SAFE_CONFIG.BASE_EMAILS;
            var BASE_CALLS = SAFE_CONFIG.BASE_CALLS;
            var stored = JSON.parse(localStorage.getItem('safe_action_counts'));
            if (!stored || stored.total < BASE_ACTIONS) {
                stored = { total: BASE_ACTIONS, emails: BASE_EMAILS, calls: BASE_CALLS };
            }
            stored.total++;
            if (type === 'email') stored.emails++;
            if (type === 'call') stored.calls++;
            localStorage.setItem('safe_action_counts', JSON.stringify(stored));

            // Update daily action counts
            var dk = new Date().toISOString().split('T')[0];
            var daily;
            try { daily = JSON.parse(localStorage.getItem('safe_daily_actions')); } catch(e2) {}
            if (daily && daily.date && daily.date !== dk) {
                localStorage.setItem('safe_yesterday_actions', JSON.stringify(daily));
            }
            if (!daily || daily.date !== dk) daily = { date: dk, emails: 0, calls: 0, total: 0 };
            daily.total++;
            if (type === 'email') daily.emails++;
            if (type === 'call') daily.calls++;
            localStorage.setItem('safe_daily_actions', JSON.stringify(daily));

            // Update weekly action counts
            var now = new Date();
            var dayOfWeek = now.getDay();
            var mon = new Date(now);
            mon.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
            var wk = mon.toISOString().split('T')[0];
            var weekly;
            try { weekly = JSON.parse(localStorage.getItem('safe_weekly_actions')); } catch(e3) {}
            if (!weekly || weekly.week !== wk) weekly = { week: wk, emails: 0, calls: 0, total: 0 };
            weekly.total++;
            if (type === 'email') weekly.emails++;
            if (type === 'call') weekly.calls++;
            localStorage.setItem('safe_weekly_actions', JSON.stringify(weekly));

            // Update streak
            var streak;
            try { streak = JSON.parse(localStorage.getItem('safe_action_streak')); } catch(e4) {}
            if (!streak) streak = { days: 0, lastDate: '' };
            if (streak.lastDate !== dk) {
                var yesterday = new Date(now);
                yesterday.setDate(now.getDate() - 1);
                var yd = yesterday.toISOString().split('T')[0];
                streak.days = (streak.lastDate === yd) ? streak.days + 1 : 1;
                streak.lastDate = dk;
                localStorage.setItem('safe_action_streak', JSON.stringify(streak));
            }
        } catch (e) {}

        // Report to national counter Cloud Function with metadata
        meta._t = Date.now();
        fetch('/api/actions/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(meta)
        }).catch(function(err) { console.warn('SAFE Action:', err.message || err); });
    }
});

// ============================================
// Bill Browser (Browse Bills Tab)
// ============================================
/**
 * Convert raw legislative titles (ALL CAPS, semicolons) to readable format.
 * "EDUCATION: SCHOOLS; GRANTS; TEACHER BONUS" → "Education: Schools, Grants, Teacher Bonus"
 */
function formatBillTitle(raw) {
    if (!raw) return 'Untitled';
    var s = raw;
    s = s.replace(/;\s*/g, ', ');
    if (raw === raw.toUpperCase()) {
        s = s.toLowerCase()
            .replace(/\b\w/g, function(c) { return c.toUpperCase(); });
    }
    s = s.replace(/\bMrna\b/g, 'mRNA')
         .replace(/\bHiv\b/g, 'HIV')
         .replace(/\bAids\b/g, 'AIDS')
         .replace(/\bCovid\b/gi, 'COVID')
         .replace(/\bFda\b/g, 'FDA')
         .replace(/\bCdc\b/g, 'CDC')
         .replace(/\bNih\b/g, 'NIH')
         .replace(/\bDna\b/g, 'DNA')
         .replace(/\bRna\b/g, 'RNA')
         .replace(/\bHhs\b/g, 'HHS')
         .replace(/\bEpa\b/g, 'EPA')
         .replace(/\bUsda\b/g, 'USDA')
         .replace(/\bDhs\b/g, 'DHS')
         .replace(/\bK-12\b/gi, 'K-12')
         .replace(/\bHpv\b/g, 'HPV')
         .replace(/\bMmr\b/g, 'MMR');
    return s;
}

var BillBrowser = {
    _initialized: false,
    _allBills: [],
    _lastDoc: null,
    _hasMore: false,
    _loading: false,
    _useFirestore: true,
    PAGE_SIZE: 50,

    init: function() {
        if (this._initialized) return;
        this._initialized = true;

        // Detect Firestore availability
        this._useFirestore = (typeof firebase !== 'undefined' && typeof firebase.firestore === 'function');

        // Populate state dropdown
        var stateSelect = document.getElementById('bb-state');
        if (stateSelect && typeof SAFE_CONFIG !== 'undefined') {
            var states = SAFE_CONFIG.STATES;
            Object.keys(states).forEach(function(code) {
                    var opt = document.createElement('option');
                opt.value = code;
                opt.textContent = states[code];
                stateSelect.appendChild(opt);
            });
        }

        // Restore filters from URL params (for bookmarkable links)
        this._restoreFiltersFromURL();

        // Add filter listeners - sync to URL on change, reset pagination
        var self = this;
        ['bb-state', 'bb-stance', 'bb-status', 'bb-impact', 'bb-category'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('change', function() {
                self._syncFiltersToURL();
                self._lastDoc = null;
                self._allBills = [];
                self.loadBills(false);
            });
        });
        var searchEl = document.getElementById('bb-search');
        if (searchEl) {
            var debounceTimer;
            searchEl.addEventListener('input', function() {
                clearTimeout(debounceTimer);
                debounceTimer = setTimeout(function() {
                    self._syncFiltersToURL();
                    self._lastDoc = null;
                    self._allBills = [];
                    self.loadBills(false);
                }, 300);
            });
        }

        // Sort control (table mode): re-render the loaded bills, no refetch
        var sortEl = document.getElementById('bb-sort');
        if (sortEl) {
            sortEl.addEventListener('change', function() {
                self._syncFiltersToURL();
                self.render();
            });
        }

        // Load More button
        var loadMoreBtn = document.getElementById('bb-load-more');
        if (loadMoreBtn) {
            loadMoreBtn.addEventListener('click', function() {
                self.loadBills(true);
            });
        }

        // Load data
        this.loadBills(false);
    },

    _filterParamMap: { 'bb-state': 'state', 'bb-stance': 'type', 'bb-status': 'status', 'bb-impact': 'priority', 'bb-category': 'category', 'bb-search': 'q', 'bb-sort': 'sort' },

    _restoreFiltersFromURL: function() {
        var params = new URLSearchParams(window.location.search);
        var map = this._filterParamMap;
        Object.keys(map).forEach(function(elId) {
            var val = params.get(map[elId]);
            if (val) {
                var el = document.getElementById(elId);
                if (el) el.value = val;
            }
        });
    },

    _syncFiltersToURL: function() {
        var params = new URLSearchParams(window.location.search);
        var map = this._filterParamMap;
        Object.keys(map).forEach(function(elId) {
            var el = document.getElementById(elId);
            var val = el ? el.value : '';
            if (val) {
                params.set(map[elId], val);
            } else {
                params.delete(map[elId]);
            }
        });
        var newURL = window.location.pathname + (params.toString() ? '?' + params.toString() : '') + window.location.hash;
        history.replaceState(null, '', newURL);
    },

    _getFilters: function() {
        return {
            state: (document.getElementById('bb-state') || {}).value || '',
            billType: (document.getElementById('bb-stance') || {}).value || '',
            status: (document.getElementById('bb-status') || {}).value || '',
            impact: (document.getElementById('bb-impact') || {}).value || '',
            category: (document.getElementById('bb-category') || {}).value || '',
            search: ((document.getElementById('bb-search') || {}).value || '').trim()
        };
    },

    loadBills: function(append) {
        if (this._loading) {
            // A filter change arrived while a load was already in flight.
            // Silently dropping it would either lose the request entirely
            // or let the in-flight promise later overwrite the just-cleared
            // list with results for the OLD filters. Queue one fresh reload
            // instead; the in-flight load's result is discarded when it lands.
            if (!append) this._reloadPending = true;
            return;
        }
        this._loading = true;
        this._reloadPending = false;

        var self = this;
        var loading = document.getElementById('bb-loading');
        if (loading) loading.style.display = '';

        if (typeof LegislationAPI === 'undefined') {
            this._loading = false;
            if (loading) loading.style.display = 'none';
            return;
        }

        var filters = this._getFilters();
        var startAfter = append ? this._lastDoc : null;

        if (this._useFirestore && typeof LegislationAPI.queryBills === 'function') {
            LegislationAPI.queryBills(filters, this.PAGE_SIZE, startAfter).then(function(result) {
                self._loading = false;
                if (loading) loading.style.display = 'none';
                if (self._reloadPending) { self._reloadPending = false; self.loadBills(false); return; }

                if (append) {
                    self._allBills = self._allBills.concat(result.bills);
                } else {
                    self._allBills = result.bills;
                }
                self._lastDoc = result.lastDoc;
                self._hasMore = result.hasMore;
                self.render();
            }).catch(function(err) {
                console.error('Firestore queryBills failed, switching to static:', err);
                self._useFirestore = false;
                self._loading = false;
                self._lastDoc = null;
                self._allBills = [];
                self.loadBills(false);
            });
        } else {
            // Static fallback - load all bills, filter client-side
            LegislationAPI.getLegislation(null).then(function(bills) {
                self._loading = false;
                if (loading) loading.style.display = 'none';
                if (self._reloadPending) { self._reloadPending = false; self.loadBills(false); return; }
                self._allBills = bills || [];
                self._hasMore = false;
                self._lastDoc = null;
                self.render();
            }).catch(function(err) {
                console.error('Bill browser load error:', err);
                self._loading = false;
                if (loading) loading.style.display = 'none';
                self.render();
            });
        }
    },

    getFilteredBills: function() {
        // If using Firestore pagination, bills are already filtered server-side
        if (this._useFirestore) {
            return this._allBills;
        }

        // Static fallback: client-side filtering
        var filters = this._getFilters();
        return this._allBills.filter(function(bill) {
            if (filters.state && bill.state !== filters.state) return false;
            if (filters.billType && bill.billType !== filters.billType) return false;
            if (filters.status === 'active') {
                if (bill.isActive !== 'Yes') return false;
            } else if (filters.status === 'dead') {
                var deadStatuses = (typeof SAFE_CONFIG !== 'undefined' && SAFE_CONFIG.DEAD_STATUSES) || [];
                if (deadStatuses.indexOf(bill.status) === -1) return false;
            } else if (filters.status === 'Passed One Chamber') {
                // The stage pipeline groups the federal chamber-specific
                // statuses under this label (see STATUS_ALIAS in
                // tracker-insights.js); match the same set here so a click
                // on that segment returns the bills it counted.
                if (['Passed One Chamber', 'Passed Senate', 'Passed House'].indexOf(bill.status) === -1) return false;
            } else if (filters.status && bill.status !== filters.status) {
                return false;
            }
            if (filters.impact && bill.impact !== filters.impact) return false;
            if (filters.category && bill.category !== filters.category) return false;
            if (filters.search) {
                var searchLower = filters.search.toLowerCase();
                var haystack = [
                    bill.billNumber || '',
                    bill.title || '',
                    bill.summary || '',
                    bill.sponsor || '',
                    bill.state || ''
                ].join(' ').toLowerCase();
                if (haystack.indexOf(searchLower) === -1) return false;
            }
            return true;
        });
    },

    render: function() {
        var grid = document.getElementById('bb-grid');
        var countEl = document.getElementById('bb-count');
        var emptyEl = document.getElementById('bb-empty');
        var loadMoreBtn = document.getElementById('bb-load-more');
        if (!grid) return;

        var bills = this.getFilteredBills();

        // Table mode: tracker.html renders rows into <tbody id="bb-grid">
        var tableMode = grid.tagName === 'TBODY';
        var tableWrap = document.getElementById('bb-tablewrap');
        if (tableWrap) tableWrap.style.display = bills.length ? '' : 'none';

        // Update count
        if (countEl) {
            var countText = bills.length + (this._hasMore ? '+' : '') + ' bill' + (bills.length !== 1 ? 's' : '') + ' found';
            countEl.textContent = countText;
        }

        // Clear grid
        while (grid.firstChild) {
            grid.removeChild(grid.firstChild);
        }

        if (bills.length === 0) {
            if (emptyEl) emptyEl.style.display = '';
            if (loadMoreBtn) loadMoreBtn.style.display = 'none';
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        if (tableMode) {
            this._sortRows(bills);
        } else {
            // Sort: high impact first, then by state
            var impactOrder = { 'High': 0, 'Medium': 1, 'Low': 2 };
            bills.sort(function(a, b) {
                var ia = impactOrder[a.impact] !== undefined ? impactOrder[a.impact] : 3;
                var ib = impactOrder[b.impact] !== undefined ? impactOrder[b.impact] : 3;
                if (ia !== ib) return ia - ib;
                return (a.state || '').localeCompare(b.state || '');
            });
        }

        // Render rows (table mode) or cards
        var self = this;
        bills.forEach(function(bill) {
            grid.appendChild(tableMode ? self.buildRow(bill) : self.buildCard(bill));
        });

        // Show/hide Load More button
        if (loadMoreBtn) {
            loadMoreBtn.style.display = this._hasMore ? '' : 'none';
        }
    },

    // ---- Table renderer (tracker.html: <table id="bb-table"> with <tbody id="bb-grid">) ----
    _catLabels: {
        'vaccine-exemption': 'Vaccine Exemptions',
        'vaccine-mandate': 'Vaccine Mandates',
        'medical-freedom': 'Medical Freedom',
        'informed-consent': 'Informed Consent',
        'vaccine-discrimination': 'Vaccine Discrimination',
        'mRNA-reclassification': 'mRNA Reclassification',
        'vaccine-injury': 'Vaccine Injury',
        'raw-milk': 'Raw Milk',
        'fluoride': 'Fluoride',
        'geoengineering': 'Geoengineering',
        'public-health': 'Public Health'
    },

    // Pipeline position for the "Status stage" sort; stopped bills sort last.
    _stageRank: {
        'Signed into Law': 9, 'Sent to Governor': 8, 'Passed Both Chambers': 7, 'In Conference': 6,
        'Passed One Chamber': 5, 'Passed Senate': 5, 'Passed House': 5, 'Floor Vote Scheduled': 4,
        'Passed Committee': 3, 'In Committee': 2, 'Introduced': 1, 'Pre-filed': 0
    },

    _sortRows: function(bills) {
        var mode = (document.getElementById('bb-sort') || {}).value || '';
        var rank = this._stageRank;
        function date(b) { return String(b.lastActionDate || ''); }
        function state(b) { return String(b.state || ''); }
        function num(b) { return String(b.billNumber || ''); }
        if (mode === 'stage') {
            bills.sort(function(a, b) {
                var ra = rank[a.status] !== undefined ? rank[a.status] : -1;
                var rb = rank[b.status] !== undefined ? rank[b.status] : -1;
                return (rb - ra) || date(b).localeCompare(date(a)) || state(a).localeCompare(state(b));
            });
        } else if (mode === 'bill') {
            bills.sort(function(a, b) {
                return state(a).localeCompare(state(b)) || num(a).localeCompare(num(b), undefined, { numeric: true });
            });
        } else {
            // Default: last action, newest first; bills with no date sort last.
            bills.sort(function(a, b) {
                return date(b).localeCompare(date(a)) || state(a).localeCompare(state(b)) ||
                    num(a).localeCompare(num(b), undefined, { numeric: true });
            });
        }
    },

    _cell: function(tr, cls, text) {
        var td = document.createElement('td');
        if (cls) td.className = cls;
        if (text !== undefined && text !== null) td.textContent = text;
        tr.appendChild(td);
        return td;
    },

    buildRow: function(bill) {
        var href = 'action.html?bill=' + encodeURIComponent(bill.billId || '') +
            (bill.state && bill.state !== 'US' ? '&state=' + encodeURIComponent(bill.state) : '');
        function remember() {
            try { sessionStorage.setItem('safe_tracker_return', window.location.pathname + window.location.search); } catch(e) {}
        }
        var tr = document.createElement('tr');

        // Bill number, linked to the action page
        var td = this._cell(tr, 'c-bill');
        var link = document.createElement('a');
        link.className = 'name';
        link.href = href;
        link.textContent = bill.billNumber || 'Unknown';
        link.addEventListener('click', remember);
        td.appendChild(link);

        // State with level sub-label
        td = this._cell(tr, 'c-state', bill.state || '');
        var lvl = document.createElement('span');
        lvl.className = 'rec-sub';
        lvl.textContent = String(bill.level || (bill.state === 'US' ? 'Federal' : 'State')).toUpperCase();
        td.appendChild(lvl);

        // Title, verbatim; CSS clamps it to two lines, full text on hover
        td = this._cell(tr, 'c-title');
        var ttl = document.createElement('div');
        ttl.className = 'ttl';
        ttl.textContent = bill.title || 'Untitled';
        ttl.title = bill.title || '';
        td.appendChild(ttl);

        // Classification badge
        td = this._cell(tr, 'c-class');
        var badge = document.createElement('span');
        if (bill.billType === 'anti') { badge.className = 'badge badge-anti'; badge.textContent = 'Anti-science'; }
        else if (bill.billType === 'pro') { badge.className = 'badge badge-pro'; badge.textContent = 'Pro-science'; }
        else { badge.className = 'badge badge-monitor'; badge.textContent = 'Monitoring'; }
        td.appendChild(badge);

        // Category, status, last action
        this._cell(tr, 'c-cat', bill.category ? (this._catLabels[bill.category] || bill.category) : '');
        this._cell(tr, 'c-status', bill.status || 'Unknown');
        var when = String(bill.lastActionDate || '');
        this._cell(tr, 'c-date', /^\d{4}-\d{2}-\d{2}/.test(when) ? when.slice(0, 10) : '');

        // Act
        td = this._cell(tr, 'c-act');
        var act = document.createElement('a');
        act.className = 'act';
        act.href = href;
        act.textContent = 'Act →';
        act.addEventListener('click', remember);
        td.appendChild(act);

        return tr;
    },

    buildCard: function(bill) {
        var card = document.createElement('a');
        card.href = 'action.html?bill=' + encodeURIComponent(bill.billId || '') +
            (bill.state && bill.state !== 'US' ? '&state=' + encodeURIComponent(bill.state) : '');
        card.addEventListener('click', function() {
            try { sessionStorage.setItem('safe_tracker_return', window.location.pathname + window.location.search); } catch(e) {}
        });
        card.className = 'bill-card';
        if (bill.billType === 'anti') card.classList.add('stance-oppose');
        else if (bill.billType === 'pro') card.classList.add('stance-support');
        else card.classList.add('stance-monitor');
        if (bill.stoppedWithAction) card.classList.add('bill-defeated');

        // Header
        var header = document.createElement('div');
        header.className = 'bill-card-header';

        var number = document.createElement('span');
        number.className = 'bill-card-number';
        number.textContent = bill.billNumber || 'Unknown';
        header.appendChild(number);

        var stateBadge = document.createElement('span');
        stateBadge.className = 'bill-card-state';
        stateBadge.textContent = bill.state || '';
        stateBadge.style.cssText = 'background:#1A2744;color:#fff;padding:0.15em 0.5em;border-radius:4px;font-size:0.75rem;font-weight:600;';
        header.appendChild(stateBadge);

        // Type badge - only label STEM-related bills (anti/pro science)
        if (bill.billType === 'anti' || bill.billType === 'pro') {
            var typeBadge = document.createElement('span');
            if (bill.billType === 'anti') {
                typeBadge.className = 'badge badge-anti';
                typeBadge.textContent = 'ANTI-SCIENCE';
            } else {
                typeBadge.className = 'badge badge-pro';
                typeBadge.textContent = 'PRO-SCIENCE';
            }
            header.appendChild(typeBadge);
        }

        card.appendChild(header);

        // Title
        var title = document.createElement('h3');
        title.className = 'bill-card-title';
        title.textContent = formatBillTitle(bill.title);
        card.appendChild(title);

        // Category tag
        if (bill.category) {
            var catLabels = {
                'vaccine-exemption': 'Vaccine Exemptions',
                'vaccine-mandate': 'Vaccine Mandates',
                'medical-freedom': 'Medical Freedom',
                'informed-consent': 'Informed Consent',
                'vaccine-discrimination': 'Vaccine Discrimination',
                'mRNA-reclassification': 'mRNA Reclassification',
                'vaccine-injury': 'Vaccine Injury',
                'raw-milk': 'Raw Milk',
                'fluoride': 'Fluoride',
                'geoengineering': 'Geoengineering',
                'public-health': 'Public Health'
            };
            var catTag = document.createElement('span');
            catTag.className = 'bill-category-tag';
            catTag.textContent = catLabels[bill.category] || bill.category;
            card.appendChild(catTag);
        }

        // Summary (truncated)
        if (bill.summary) {
            var summary = document.createElement('p');
            summary.className = 'bill-card-summary';
            var text = formatBillTitle(bill.summary);
            if (text.length > 120) text = text.substring(0, 120) + '...';
            summary.textContent = text;
            card.appendChild(summary);
        }

        // Meta row
        var meta = document.createElement('div');
        meta.className = 'bill-card-meta';

        var statusSpan = document.createElement('span');
        statusSpan.textContent = bill.status || 'Unknown';
        meta.appendChild(statusSpan);

        if (bill.impact) {
            var impactSpan = document.createElement('span');
            impactSpan.textContent = bill.impact + ' Priority';
            impactSpan.style.cssText = 'font-weight:600;' + (bill.impact === 'High' ? 'color:#dc2626;' : bill.impact === 'Medium' ? 'color:#d97706;' : 'color:#6b7280;');
            meta.appendChild(impactSpan);
        }

        card.appendChild(meta);

        // Footer with sponsor
        if (bill.sponsor) {
            var footer = document.createElement('div');
            footer.className = 'bill-card-footer';
            var sponsorText = document.createElement('span');
            sponsorText.textContent = 'Sponsor: ' + bill.sponsor;
            footer.appendChild(sponsorText);
            card.appendChild(footer);
        }

        return card;
    }
};
