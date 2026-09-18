# SAFE Action Website

Public website of the Science and Freedom for Everyone Action Fund (scienceandfreedom.com), a 501(c)(4) social welfare organization (EIN 41-4491870). Contributions are not tax-deductible as charitable contributions.

Static HTML/CSS/JS front end with Firebase (Hosting, Firestore, Cloud Functions) and a Python crawler that scores science-related legislation across all 50 states and DC.

- Legislative tracker and open bill dataset (data/ refreshed daily by GitHub Actions)
- Candidate pledge program (voluntary, nonpartisan; no endorsements)
- Volunteer intake, mailing list (double opt-in), and donations via Stripe

Deploys automatically from main via GitHub Actions to Firebase Hosting. Code licensed GPL-3.0 (see LICENSE).
