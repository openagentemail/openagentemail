#!/usr/bin/env python3
"""Independent Python 3 verifier for the public webhook signature v1 corpus (RFC-0001 §7, §12.1, §14 item 1).

This intentionally uses only Python's standard library and never imports or
executes the JavaScript production implementation. It checks the committed
corpus against an independent HMAC-SHA256 calculation.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import sys
from pathlib import Path


def derive_webhook_key(root_secret: str, webhook_id: str, epoch: int) -> str:
    message = f"webhook-signing-v1\n{webhook_id}\n{epoch}".encode("utf-8")
    raw_key = hmac.new(root_secret.encode("utf-8"), message, hashlib.sha256).digest()
    return "whs_" + raw_key.hex()


def compute_webhook_signature(displayed_secret: str, t: int, raw_body: str) -> str:
    # §12.1: displayedSecret (68 ASCII bytes, including 'whs_' prefix) is the signing key
    signing_key = displayed_secret.encode("utf-8")
    signed_payload = f"{t}.{raw_body}".encode("utf-8")
    return hmac.new(signing_key, signed_payload, hashlib.sha256).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[1]
        / "test/fixtures/webhook-signature-vectors.v1.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    require(
        fixture.get("format") == "openagentemail.webhook-signature-vectors",
        "fixture format",
    )
    require(fixture.get("version") == 1, "fixture version")
    require(fixture.get("signatureScheme") == "v1", "signatureScheme")

    vectors = fixture.get("vectors")
    require(isinstance(vectors, list) and len(vectors) == 4, "vector count must be 4")

    for v in vectors:
        vid = v["id"]
        root = v["rootSecret"]
        whk_id = v["webhookId"]
        epoch = v["epoch"]
        t = v["timestampSec"]
        raw_body = v["rawBody"]

        # 1. Test key derivation
        derived_secret = derive_webhook_key(root, whk_id, epoch)
        require(
            derived_secret == v["displayedSecret"],
            f"{vid}: derived secret mismatch: {derived_secret} != {v['displayedSecret']}",
        )

        # 2. Test primary signature
        expected_sig = v.get("expectedSignature") or v.get("expectedPrimarySignature")
        sig = compute_webhook_signature(derived_secret, t, raw_body)
        require(sig == expected_sig, f"{vid}: signature mismatch: {sig} != {expected_sig}")

        # 3. If overlap vector, test previous epoch signature
        if "previousEpoch" in v:
            prev_derived = derive_webhook_key(root, whk_id, v["previousEpoch"])
            require(
                prev_derived == v["previousDisplayedSecret"],
                f"{vid}: previous derived secret mismatch",
            )
            prev_sig = compute_webhook_signature(prev_derived, t, raw_body)
            require(
                prev_sig == v["expectedPreviousSignature"],
                f"{vid}: previous signature mismatch",
            )
            expected_header = f"t={t},v1={sig},v1={prev_sig}"
            require(
                expected_header == v["expectedHeader"],
                f"{vid}: expected header mismatch",
            )
        else:
            expected_header = f"t={t},v1={sig}"
            require(
                expected_header == v["expectedHeader"],
                f"{vid}: expected header mismatch",
            )

    print(f"verified {len(vectors)} public v1 webhook signature vectors with independent Python standard-library verification")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"webhook signature vector verification failed: {error}", file=sys.stderr)
        sys.exit(1)
