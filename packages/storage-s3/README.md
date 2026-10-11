# @starlight-intelligence/creator-storage-s3

S3-compatible storage connector (AWS S3, Cloudflare R2, MinIO) for the creator substrate: content-addressed uploads and public or presigned URLs.

Part of the [Starlight creator substrate](https://github.com/frankxai/starlight-creator-mcp). BYOK and local-first.

S3 is an optional server dependency; local-only installs can use `npm install --omit=optional`.
An explicitly configured bucket fails closed: if this connector was omitted (`--omit=optional`)
or either S3 credential is missing, server startup and `doctor` fail with a specific error
instead of silently falling back to local storage. Native AWS
uses the SDK region chain (explicit `region`, `AWS_REGION`, shared AWS config); only custom
endpoints default to `auto`. A missing region is an error, not an invented AWS region.

AWS is never implicitly trusted: set `policy.allowHosts` to the exact SDK endpoint
hostname(s), e.g. `s3.us-east-1.amazonaws.com` for path-style AWS (the default), or
`<bucket>.s3.us-east-1.amazonaws.com` with `forcePathStyle: false`, or your account's R2 endpoint.
Configuration does not automatically trust an endpoint. SDK requests use `guardedFetch`,
including connection-time DNS checks, redirect validation, deadlines and `maxAssetBytes`.
Private endpoints remain blocked; the private-host override is for isolated tests only.
Downloads are streamed within the byte budget and verified against the content-addressed
SHA-256; only missing objects return null. Authentication/network/size/integrity failures throw.
Named `NoSuchBucket` and other service errors remain errors even with HTTP 404.
An ambiguous bodyless object 404 triggers a read-only `HeadBucket` check before
returning absence. This requires `s3:ListBucket`; denied or missing buckets fail
instead of being reported as missing assets. Cancellation also reaches that check.
Public-domain URLs encode individual object-key segments so spaces, `%`, `?`
and `#` remain part of the key rather than changing the URL path/query/fragment.
Prefixes containing a standalone `.` or `..` segment are rejected before any
request: URL normalization can otherwise point to a different object. Ordinary
dot-containing names such as `.hidden` and `..backup` remain supported. See
[AWS object-key guidance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-keys.html#object-key-guidelines).
Interactive `setup --storage` stores an optional temporary-credential session
token; blank retains a stored token and `-` deletes it when switching credentials.
Uploads are buffered, so the SigV4-signed `Content-Length` is checked against the body and
then derived by Fetch; `Expect: 100-continue` (unsigned, and rejected by Fetch) is disabled
through the SDK's `expectContinueHeader: false`. Streaming request bodies are refused.

`presignUpload(sha256, ext, mime)` returns a credential-authenticated SigV4 URL.
Uploaders **must** send `Content-Type: <mime>` and
`x-amz-checksum-sha256: <base64 of the 32 digest bytes, not the hex text>`.
Both headers are signed; S3 verifies the body checksum. Treat the URL as a short-lived
bearer capability and never log it. Browser requests require matching bucket CORS rules.
Presigning performs no upload and does not prove credentials or write permission work.
All object operations require a lowercase 64-character hexadecimal SHA-256 and
an extension of 1 to 16 lowercase ASCII letters or digits, without a leading dot.
Invalid components fail before constructing a key, signing a capability or making
a request. Custom extensions outside this format must migrate before using this connector.
`publicUrl` verifies the object at the currently configured bucket and prefix with
HeadObject before returning either a public-domain or presigned download URL.
An absent key returns null; permission, bucket and network failures remain errors.
After changing storage settings, resynchronize assets to the new location before
publishing them. This does not migrate recorded locations, verify CDN mappings or
guarantee that an object remains available after the check. Operators must keep
the configured public domain mapped to the bucket and prefix.
`doctor` performs no writes. It first sends HeadBucket (`s3:ListBucket`): a 404 fails as a
missing bucket and a 403 fails as indeterminate access. It then HEADs a missing probe key; 404
is reachable, while 403 is indeterminate access, not proof of rejected credentials. It fails
the check without claiming GetObject/PutObject were tested.

Contracts: [AWS region configuration](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/setting-region.html),
[HeadBucket permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html),
[HeadObject permissions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html),
[official SDK checksum signing example](https://github.com/aws/aws-sdk-js-v3/tree/main/packages/s3-request-presigner).

MIT.
