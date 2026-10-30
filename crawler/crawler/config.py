"""Central configuration for the SAFE Action crawler."""

import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

# ── Paths ─────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).parent.parent.parent  # SAFE Action Website root
DATA_DIR = PROJECT_ROOT / "data"
CACHE_DIR = Path(__file__).parent.parent / ".cache"

# ── API Keys ──────────────────────────────────────────
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "")

# Claude models for analysis
EXTRACTION_MODEL = os.getenv("EXTRACTION_MODEL", "claude-sonnet-5")
# Tried in order if the primary model id is rejected by the API.
MODEL_FALLBACKS = [m for m in os.getenv("MODEL_FALLBACKS", "claude-haiku-4-5-20251001,claude-sonnet-4-20250514").split(",") if m]
REASONING_MODEL = os.getenv("REASONING_MODEL", "claude-sonnet-4-20250514")

# Debug: log if API key is present (not the key itself)
if ANTHROPIC_API_KEY:
    print(f"ANTHROPIC_API_KEY loaded ({len(ANTHROPIC_API_KEY)} chars, starts with {ANTHROPIC_API_KEY[:7]}...)")
else:
    print("WARNING: ANTHROPIC_API_KEY is empty")

# ── Open States API ──────────────────────────────────
OPENSTATES_API_KEY = os.getenv("OPENSTATES_API_KEY", "")
OPENSTATES_BASE_URL = "https://v3.openstates.org"
OPENSTATES_RATE_LIMIT = 1.0  # seconds between requests

# ── LegiScan API ────────────────────────────────────
LEGISCAN_API_KEY = os.getenv("LEGISCAN_API_KEY", "")
LEGISCAN_BASE_URL = "https://api.legiscan.com/"
LEGISCAN_RATE_LIMIT = 0.5  # seconds between requests; monthly cap is 10,000 queries (budget in sources/legiscan.py)

# ── Crawl Targets ─────────────────────────────────────
CONGRESS_GOV_BASE = "https://www.congress.gov"

STATE_LEGISLATURE_URLS = {
    "TX": "https://capitol.texas.gov/Members/Members.aspx",
    "FL": "https://www.myfloridahouse.gov/Representatives",
    "CA": "https://www.legislature.ca.gov/legislators",
    "OH": "https://www.legislature.ohio.gov/legislators",
    "NY": "https://www.nysenate.gov/senators-committees",
    "CO": "https://leg.colorado.gov/legislators",
    "WA": "https://leg.wa.gov/legislature/pages/memberinformation.aspx",
    "ID": "https://legislature.idaho.gov/legislators/",
    "MO": "https://www.house.mo.gov/MemberGridCluster.aspx",
    "GA": "https://www.legis.ga.gov/members/senate",
    "PA": "https://www.legis.state.pa.us/cfdocs/legis/home/member_information/",
    "MA": "https://malegislature.gov/Legislators/Members/Senate",
}

NEWS_SEARCH_TERMS = [
    "vaccine legislation 2026",
    "anti-vaccine bill state legislature",
    "public health committee hearing vaccine",
    "medical freedom bill",
    "science education legislation",
    "vaccine mandate bill",
    "informed consent vaccine law",
]

# ── Rate Limiting ─────────────────────────────────────
CRAWL_DELAY_SECONDS = 2.0
MAX_CONCURRENT_REQUESTS = 3
NEWS_CRAWL_DELAY = 1.5

# ── Cache TTLs (hours) ────────────────────────────────
LEGISLATOR_CACHE_HOURS = 168   # 7 days
BILL_CACHE_HOURS = 24          # 1 day — bills update frequently
NEWS_CACHE_HOURS = 12
ANALYSIS_CACHE_HOURS = 72      # 3 days

# ── Analysis Settings ─────────────────────────────────
MAX_LEGISLATORS_PER_BATCH = 50

PERSUADABILITY_CATEGORIES = {
    "champion":     (9, 10),
    "likely-win":   (7, 8),
    "fence-sitter": (4, 6),
    "unlikely":     (2, 3),
    "opposed":      (0, 1),
}

# Priority states — these match the site's focus areas
PRIORITY_STATES = [
    "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
    "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
    "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
    "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
    "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
    "DC",
]

HEALTH_COMMITTEE_KEYWORDS = [
    "health", "public health", "human services", "energy and commerce",
    "HELP", "appropriations", "labor", "education", "ways and means",
]

SCIENCE_BACKGROUND_KEYWORDS = [
    "physician", "doctor", "nurse", "pharmacist", "scientist",
    "researcher", "epidemiologist", "biologist", "chemist",
    "MD", "RN", "PhD", "DO", "PharmD", "MPH",
]
