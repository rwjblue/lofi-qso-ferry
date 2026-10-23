# Synthetic signing fixtures

Every private key and contact in this directory is intentionally public synthetic test material. The issuing root is named `Ferry synthetic root only` and has no ARRL authority. Never import these files into a live account or submit their QSOs.

`current.p12` uses OpenSSL 3 PBES2/AES-256 with SHA-256 MAC; `legacy.p12` uses legacy RC2/3DES with SHA-1 MAC. `second.p12` authorizes W2AW to exercise account routing; it deliberately reuses the synthetic fixture RSA key. All use the public password `ferry-fixture`. The original issuing-root private key is not retained in the repository.

Rebuild these containers with OpenSSL 3 from the checked-in synthetic PEMs:

```sh
openssl pkcs12 -export -in fixtures/signing/certificate.pem -inkey fixtures/signing/key.pem -certfile fixtures/signing/root.pem -out fixtures/signing/current.p12 -passout pass:ferry-fixture -iter 2048
openssl pkcs12 -export -legacy -in fixtures/signing/certificate.pem -inkey fixtures/signing/key.pem -certfile fixtures/signing/root.pem -out fixtures/signing/legacy.p12 -passout pass:ferry-fixture -iter 2048
openssl pkcs12 -export -in fixtures/signing/second-certificate.pem -inkey fixtures/signing/key.pem -certfile fixtures/signing/root.pem -out fixtures/signing/second.p12 -passout pass:ferry-fixture -iter 2048
```

Fresh salts/IVs change container bytes while imported keys and the signing vector stay identical. `openssl.cnf` records the synthetic LoTW attribute/extension OIDs and authorization dates. The certificates were generated on 2026-10-22 with 1,460-day leaf and 3,650-day root validity. Date-stable tests use 2027-01-01; connection tests deliberately enforce current certificate validity and will need fixture renewal before expiry.

These PEM fixtures wrap custom extension values in DER strings. The signing tests also generate synthetic blank-password containers with TQSL's raw-text DXCC and QSO-date extension values, including malformed variants that must fail closed. No personal certificate or key is used in those tests.

`vector.json` is an independently checked OpenSSL RSA/SHA-1 vector. To regenerate the signature, write its `canonical` property as ASCII bytes **without a trailing newline**, run `openssl dgst -sha1 -sign fixtures/signing/key.pem -out /tmp/ferry-vector.sig /tmp/ferry-canonical`, and Base64-encode the signature. Production signing uses WebCrypto in the Worker, not the OpenSSL CLI.

The Wavelog MIT license accompanies the adapted field ordering. These generated fixtures and their associated tests do not establish LoTW server acceptance.
