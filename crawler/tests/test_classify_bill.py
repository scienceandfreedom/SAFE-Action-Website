"""Regression cases for the keyword bill classifier.

The pro cases are bills a 2026-10-04 LLM review of all pro/anti bills found
tagged anti because they mention "exemption", "liability", or a vaccine
requirement while actually removing exemptions or expanding vaccine access.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from crawler.sources.legiscan import _classify_bill  # noqa: E402

PRO = [
    # WV-HB4146
    "To require compulsory vaccinations for anyone employed by the public school system in this state.",
    # MN-SF4458
    "Prohibit use of an exemption to immunization due to conscientiously held beliefs",
    # MN-SF3439
    "Use of an exemption to immunization due to conscientiously held beliefs prohibition for immunization against measles, mumps, and rubella",
    # MN-HF3239
    "Use of an exemption to immunization due to conscientiously held beliefs for immunization against measles, mumps, and rubella prohibited.",
    # WI-AB891 / WI-SB950
    "Eliminating personal conviction exemption from immunizations.",
    # PA-HB1881 / PA-SB1055
    "Further providing for pharmacy technician and pharmacy technician trainee registration, qualifications and supervision; providing for administration of injectable medications, biologicals and immunizations",
    # NY-A02297
    "Authorizes emergency medical technicians to administer certain vaccines pursuant to non-patient specific orders and under the authority of an emergency medical services director after receiving appropriate training",
    # NY-A09140 / NY-S09604
    "Provides liability protections for health care providers who issue vaccines so long as such vaccination does not arise out of willful misconduct or gross negligence.",
    # NY-A01121
    "Allows livestock owners to purchase and possess rabies vaccine and to vaccinate their livestock against rabies during emergency rabies outbreak situations as determined by the commissioner of health",
]

ANTI = [
    "Eliminating hepatitis-b and meningitis as required vaccines",
    "Permitting religious exemptions for compulsory immunizations",
    "No Vaccine Mandates in Higher Education Act",
    "To prohibit any entity that receives Federal funds from the COVID relief packages from mandating employees receive a COVID-19 vaccine, and for other purposes.",
    "Justice for Vaccine Injured Veterans Act of 2025",
    # MN-SF1126: "unpasteurized" used to match the pro keyword "pasteurized"
    "Sales of unpasteurized milk authorization",
]

# Direction cannot be read from these titles: never Oppose on a guess.
NOT_ANTI = [
    # MN-HF3775
    "Requirements for exemption from immunizations for conscientiously held beliefs modified, commissioner of health required to develop an immunizations education module, and money appropriated.",
    "Immunization exemptions; revise",
    "Vaccine liability; provisions",
]


@pytest.mark.parametrize("title", PRO)
def test_pro(title):
    assert _classify_bill(title)[:2] == ("pro", "Support")


@pytest.mark.parametrize("title", ANTI)
def test_anti(title):
    assert _classify_bill(title)[:2] == ("anti", "Oppose")


@pytest.mark.parametrize("title", NOT_ANTI)
def test_ambiguous_is_not_anti(title):
    assert _classify_bill(title)[0] != "anti"


def test_human_review_still_wins(tmp_path, monkeypatch):
    """Stance overrides and carried-forward verification beat the classifier."""
    import json

    from crawler import main

    title = "Permitting religious exemptions for compulsory immunizations"
    bill_type, stance, _ = _classify_bill(title)
    assert bill_type == "anti"

    (tmp_path / "stance-overrides.json").write_text(
        json.dumps({"overrides": {"XX-1": {"billType": "monitor", "note": "test"}}})
    )
    monkeypatch.setattr(main, "DATA_DIR", tmp_path)
    fresh = [
        {"billId": "XX-1", "title": title, "billType": bill_type, "stance": stance},
        {"billId": "XX-2", "title": title, "billType": bill_type, "stance": stance},
    ]
    previous = [{"billId": "XX-2", "title": title, "billType": "pro", "stance": "Support",
                 "verification": {"verdict": "pro"}}]
    main._carry_forward_sponsorships(fresh, previous)
    assert main._apply_stance_overrides(fresh) == 1
    assert (fresh[0]["billType"], fresh[0]["stance"]) == ("monitor", "Monitor")
    assert (fresh[1]["billType"], fresh[1]["stance"]) == ("pro", "Support")
