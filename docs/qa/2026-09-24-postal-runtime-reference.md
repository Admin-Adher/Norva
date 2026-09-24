# Postal runtime source reference, 24 September 2026

The running Edge functions mount contained six Postal modules/resources absent from Git: the private auth-pair protocol, durable canary integration, signature verifier, HTTP boundary, webhook entry point and its trusted public-key configuration. A rebuild from the repository would omit that receive-only canary and the private pair protocol module. These files have now been copied from the live mount into the versioned function tree. There is no production runtime change in this PR.

The source SHA-256 values checked on the live mount were `a5ff689f` (private protocol), `6e7be2d4` (durable integration), `d1006d2a` (HTTP boundary), `cf6ea587` (signature verifier), and `f65f5612` (webhook entry). The JSON resource SHA-256 was `deb90748`. Its single value is an RSA **public** verification key in PEM form; it contains no private key or bearer secret. Key rotation requires updating this versioned public resource and the running mount together.

Local runtime tests generate a disposable RSA key and verify a signed event, duplicate acknowledgement, tampering rejection and unknown-key rejection. A second test exercises encrypted forwarding of only the exact permitted auth pair and requires the coordinator's durable receipt. The checked-in trust resource is parsed and imported as a public key. The webhook entry and its JSON import parse as an esbuild bundle.

These tests establish reconstruction and boundary behavior only. They do not prove a fresh production Postal delivery, a customer inbox receipt, or activation of any commercial feature. The canary remains receive-only and must not be interpreted as a second general mail sender. Further Edge differences outside these files remain to be reconciled.
