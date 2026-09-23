# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

We take the security of api-proxy seriously. If you believe you have found a
security vulnerability, please report it to us as described below.

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please report them via email to the project maintainers.

You should receive a response within 48 hours. If for some reason you do not,
please follow up via email to ensure we received your original message.

Please include the following information:
- Type of issue (e.g. buffer overflow, SQL injection, cross-site scripting, etc.)
- Full paths of source file(s) related to the manifestation of the issue
- The location of the affected source code (tag/branch/commit or direct URL)
- Any special configuration required to reproduce the issue
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the issue, including how an attacker might exploit it

## Preferred Languages

We prefer all communications to be in English.

## Policy

We will acknowledge receipt of your vulnerability report and will send you regular
updates about our progress. If we determine that the issue is a valid vulnerability,
we will:

1. Confirm the issue and determine its severity
2. Develop a fix and test it
3. Release a security advisory and patch

## Security Best Practices for Deployment

- Always use environment variables for API keys, never hardcode them
- Run behind a reverse proxy (nginx, Caddy) for TLS termination
- Restrict network access to the proxy port using firewall rules
- Use `NODE_ENV=production` to disable debug logging
- Regularly rotate NVIDIA API keys
- Monitor `/internal/health` for cooldown alerts
