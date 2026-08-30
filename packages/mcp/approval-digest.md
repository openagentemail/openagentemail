# Approval action digest, version 1

An approval action is a plain JSON object with exactly `type` (non-empty string),
`name` (non-empty string), and `arguments` (any JSON value). Values must be null,
boolean, finite number, string, array, or plain object; non-finite numbers and
non-plain objects are rejected.

For v1, recursively serialize the action as follows: object keys use JavaScript
`Object.keys(value).sort()` default ordering over UTF-16 code units (not Unicode
code-point order); arrays retain their supplied ordering; values and keys use
JavaScript `JSON.stringify` escaping and number spelling. Thus `-0` serializes as
`0`. Objects use no whitespace (`{"key":value}`), arrays use no whitespace, and
the resulting text is encoded as UTF-8.

Number spelling is normatively the finite-number path of ECMA-262
[`SerializeJSONProperty`](https://tc39.es/ecma262/#sec-serializejsonproperty),
which uses [`Number::toString`](https://tc39.es/ecma262/#sec-numeric-types-number-tostring).
That algorithm chooses the shortest round-trippable decimal. Its decimal notation
window is `1e-6 <= abs(x) < 1e21`: `0.000001` is decimal, while `1e-7` is
exponential; `1e21` is exponential. Exponential notation uses a signed exponent
for non-negative exponents (`1e+21`, not `1e21`) and no padded exponent zeros.
These requirements are part of v1, not illustrative formatting preferences.

Non-JavaScript implementations must reproduce the corpus's JavaScript behavior:
UTF-16 key ordering, `JSON.stringify` escaping and number spelling (including
exponent spelling), `-0` normalization, UTF-8 bytes, and lower-case SHA-256 hex.

The action digest is SHA-256 of those UTF-8 bytes, expressed as raw lower-case
hexadecimal. It has no `sha256:` prefix. This describes the existing v1 behavior;
it is not a general canonical-JSON standard.

Implementations of v1 **must not** change this documented canonicalization
behavior. Any incompatible canonicalization change requires a new recipe version
and corresponding new versioned vectors.

The public, versioned interoperability vectors are
[`approval-canonical-vectors.v1.json`](./approval-canonical-vectors.v1.json).
Each mutation `path` is a non-root [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901),
not a dot-split path. The empty string is the rejected root pointer; `/` is valid
and addresses a member whose key is the empty string, while `/arguments/literal.dot`
addresses a key containing a literal dot.
The committed fixture is the normative v1 corpus; tests do not generate it.
They verify it with a JavaScript reference verifier implemented independently of
the production canonicalization helper, and with a separate Python standard-library
verifier. The Python verifier is a corpus check, not a replacement for the
ECMA-262 algorithms above or a proof about arbitrary JSON implementations.
