#!/usr/bin/env python3
"""Independent Python 3 verifier for the public approval-canonical v1 corpus.

This intentionally uses only Python's standard library and never imports or
executes the JavaScript production implementation. It checks the committed
corpus, rather than generating it.
"""
from __future__ import annotations

import copy
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any


class NegativeZero:
    def __deepcopy__(self, _memo: dict[int, Any]) -> "NegativeZero":
        return self


NEGATIVE_ZERO = NegativeZero()
HEX_SHA256 = re.compile(r"[0-9a-f]{64}\Z")


def parse_integer(token: str) -> float | NegativeZero:
    # json.loads otherwise turns the JSON lexical token -0 into Python int 0.
    return NEGATIVE_ZERO if token == "-0" else float(token)


def js_number(value: Any) -> str:
    """Render a finite JSON number with ECMA-262 Number::toString's v1 rules.

    Python 3's repr(float) supplies the shortest round-trippable significand;
    this function independently applies ECMAScript's decimal-window and
    exponent spelling rules, including the explicit plus sign.
    """
    if value is NEGATIVE_ZERO:
        return "0"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise TypeError("not a JSON number")
    if isinstance(value, int):
        try:
            value = float(value)
        except OverflowError as error:
            raise ValueError("non-finite number") from error
    if not math.isfinite(value):
        raise ValueError("non-finite number")
    if value == 0:
        return "0"
    sign = "-" if value < 0 else ""
    raw = repr(abs(value)).lower()
    mantissa, separator, exponent_text = raw.partition("e")
    exponent = int(exponent_text) if separator else 0
    if "." in mantissa:
        mantissa = mantissa.rstrip("0").rstrip(".")
    decimal_position = mantissa.index(".") if "." in mantissa else len(mantissa)
    digits_with_zeros = mantissa.replace(".", "")
    leading_zeros = len(digits_with_zeros) - len(digits_with_zeros.lstrip("0"))
    digits = digits_with_zeros.lstrip("0")
    if not digits:
        return "0"
    n = decimal_position + exponent - leading_zeros
    k = len(digits)
    if k <= n <= 21:
        body = digits + "0" * (n - k)
    elif 0 < n <= 21:
        body = digits[:n] + "." + digits[n:]
    elif -6 < n <= 0:
        body = "0." + "0" * (-n) + digits
    else:
        coefficient = digits if k == 1 else digits[0] + "." + digits[1:]
        exponent_value = n - 1
        exponent_sign = "+" if exponent_value >= 0 else ""
        body = f"{coefficient}e{exponent_sign}{exponent_value}"
    return sign + body


def json_string(value: str) -> str:
    # ensure_ascii=False matches JSON.stringify's literal non-ASCII output.
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def utf16_sort_key(value: str) -> bytes:
    return value.encode("utf-16-be", "surrogatepass")


def canonical(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, str):
        return json_string(value)
    if value is NEGATIVE_ZERO or (isinstance(value, (int, float)) and not isinstance(value, bool)):
        return js_number(value)
    if isinstance(value, list):
        return "[" + ",".join(canonical(item) for item in value) + "]"
    if isinstance(value, dict):
        entries = (f"{json_string(key)}:{canonical(value[key])}" for key in sorted(value, key=utf16_sort_key))
        return "{" + ",".join(entries) + "}"
    raise TypeError("not plain JSON")


def action(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"type", "name", "arguments"}:
        raise ValueError("invalid action shape")
    if not isinstance(value["type"], str) or not value["type"]:
        raise ValueError("invalid action type")
    if not isinstance(value["name"], str) or not value["name"]:
        raise ValueError("invalid action name")
    return value


def pointer_tokens(pointer: str) -> list[str]:
    if not pointer.startswith("/"):
        raise ValueError("mutation path must be a non-root JSON Pointer")
    tokens = pointer[1:].split("/")
    for token in tokens:
        if re.search(r"~(?:[^01]|$)", token):
            raise ValueError("invalid JSON Pointer escape")
    return [token.replace("~1", "/").replace("~0", "~") for token in tokens]


def mutated(source: Any, pointer: str, replacement: Any) -> Any:
    result = copy.deepcopy(source)
    tokens = pointer_tokens(pointer)
    target = result
    for token in tokens[:-1]:
        target = target[int(token)] if isinstance(target, list) else target[token]
    final = tokens[-1]
    if isinstance(target, list):
        target[int(final)] = replacement
    else:
        target[final] = replacement
    return result


def digest(value: Any) -> str:
    return hashlib.sha256(canonical(action(value)).encode("utf-8")).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def check_pointer_regressions() -> None:
    source = {"a/b": {"~": {"": True}}}
    changed = mutated(source, "/a~1b/~0/", False)
    require(changed["a/b"]["~"][""] is False, "escaped/empty JSON Pointer mutation failed")
    require(source["a/b"]["~"][""] is True, "JSON Pointer mutation changed source")
    try:
        pointer_tokens("")
    except ValueError:
        pass
    else:
        raise AssertionError("root JSON Pointer must be rejected")


def check_number_boundaries(vector: dict[str, Any]) -> None:
    arguments = vector["source"]["arguments"]
    require(arguments["negativeZero"] is NEGATIVE_ZERO, "raw JSON -0 was not retained")
    expected = {
        "negativeZero": "0",
        "decimal": "0.000001",
        "exponentLow": "1e-7",
        "exponentHigh": "1e+21",
        "fraction": "1.23",
    }
    for key, spelling in expected.items():
        require(js_number(arguments[key]) == spelling, f"wrong JavaScript number spelling for {key}")
    require(js_number(parse_integer("9007199254740993")) == "9007199254740992", "large integer Number rounding")
    require(js_number(parse_integer("1000000000000000000000")) == "1e+21", "large integer exponent spelling")
    try:
        js_number(parse_integer("1" + "0" * 400))
    except ValueError:
        pass
    else:
        raise AssertionError("non-finite parsed integer must fail closed")


def main() -> None:
    fixture_path = Path(__file__).resolve().parents[1] / "test/fixtures/approval-canonical-vectors.v1.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"), parse_int=parse_integer, parse_float=float)
    require(fixture.get("format") == "openagentemail.approval-canonical-vectors", "fixture format")
    require(fixture.get("version") == 1, "fixture version")
    vectors = fixture.get("vectors")
    require(isinstance(vectors, list) and len(vectors) == 4, "fixture vectors")
    by_id = {vector.get("id"): vector for vector in vectors}
    require(set(by_id) == {"unicode-v1", "number-boundaries-v1", "nested-order-v1", "utf16-key-order-v1"}, "vector ids")
    check_number_boundaries(by_id["number-boundaries-v1"])
    utf16_order = canonical({"\uffff": "bmp", "😀": "astral"})
    require(utf16_order == '{"😀":"astral","￿":"bmp"}', "UTF-16 key ordering")
    check_pointer_regressions()
    for vector in vectors:
        source = action(vector["source"])
        canonical_text = canonical(source)
        require(canonical_text == vector["canonicalUtf8Json"], f"{vector['id']} canonical JSON")
        require(HEX_SHA256.fullmatch(vector["sha256"]) is not None, f"{vector['id']} lowercase SHA-256")
        require(digest(source) == vector["sha256"], f"{vector['id']} digest")
        if "equivalentSource" in vector:
            require(digest(vector["equivalentSource"]) == vector["sha256"], f"{vector['id']} equivalent source")
        for mutation in vector["mutations"]:
            changed = mutated(source, mutation["path"], mutation["value"])
            require(HEX_SHA256.fullmatch(mutation["sha256"]) is not None, f"{vector['id']} mutation lowercase SHA-256")
            require(digest(changed) == mutation["sha256"], f"{vector['id']} mutation digest")
            require(digest(changed) != vector["sha256"], f"{vector['id']} mutation changed digest")
    print("verified 4 public v1 vectors with independent Python standard-library canonicalization")


if __name__ == "__main__":
    try:
        main()
    except (AssertionError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"approval canonical vector verification failed: {error}", file=sys.stderr)
        sys.exit(1)
