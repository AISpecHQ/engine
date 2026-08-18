# Authentication Architecture

## Overview
This document defines the authentication requirements and architecture for the AISpec development system. It specifies the chosen authentication mechanism (JWT), user data model, token lifecycle, and integration points with the existing API.

## Authentication Requirements
- **User Identification**: The system must uniquely identify all authenticated users.
- **Authorization**: Determine what resources a user can access after authentication.
- **Security**: Protect credentials and tokens from unauthorized access.
- **Scalability**: The solution must work with a horizontally scalable HTTP API.
- **Statelessness**: The system should not rely on server-side sessions for every request to allow easy scaling.
- **Flexibility**: Must support both programmatic (API) and interactive (UI) clients.

## Authentication Mechanism Selection: JWT (JSON Web Tokens)

### Justification
- **Stateless**: JWT contains all user claims; no session storage needed.
- **Scalability**: Works seamlessly with load-balanced microservices and API gateways.
- **Simplicity**: Easier to implement than OAuth2 while still supporting refresh tokens.
- **Flexibility**: Can be used for both API and web clients with minimal modification.
- **Security**: Can be signed with RS256 using asymmetric keys for enhanced security.
- **Ecosystem**: Comprehensive library support in all major languages (Python, Node, Go, etc.).

### OAuth2 Not Chosen
OAuth2 is heavier and mostly needed when integrating third-party login or delegated access. The system currently has no external agents requiring scoped access, so JWT is sufficient.

## User Data Model

### Required Fields
- **id** (string): Unique user identifier (UUID).
- **email** (string): Unique email address; also used for login.
- **password_hash** (string): Securely hashed password (using bcrypt or similar).
- **full_name** (string): The display name of the user.
- **role** (string): User role (e.g., 'admin', 'user') for authorization.
- **is_active** (boolean): Flag to enable/disable user accounts.
- **api_keys** (string[]): List of API keys (optional) for programmatic access.
- **created_at** (datetime): When the user was created.
- **updated_at** (datetime): Last update timestamp.

### Data Storage
User data will be stored in the existing PostgreSQL database in a table named `users`. The system uses an ORM (currently defined in the codebase as `User` model) to manage this table.

## Token Lifecycle

### Access Token
- **Type**: JWT (compact, URL-safe).
- **Payload Claims**: `sub` (user id), `email`, `role`, `iat` (issued at), `exp` (expiration time).
- **Expiration**: 15 minutes (short-lived).
- **Issued**: At login or when the access token is refreshed.
- **Verification**: The API middleware verifies signature and expiration every request.
- **Storage**: Client (browser or mobile) stores it in memory, session, or secure storage (e.g., HttpOnly cookie).

### Refresh Token
- **Type**: Opaque string or JWT with longer expiration.
- **Expiration**: 7 days, configurable.
- **Storage**: Stored in a dedicated `refresh_tokens` table on the server, linked to the user.
- **Usage**: Sent only to a dedicated `/api/auth/refresh` endpoint to obtain a new access token and maybe rotate the refresh token.
- **Revocation**: Tokens can be revoked by setting `revoked_at` in the database.

### Authentication Flow
1. Client sends credentials (`email` and `password`) to `POST /api/auth/login`.
2. Server validates credentials; on success, issues an access token and a refresh token.
3. Client uses the access token in the `Authorization: Bearer <token>` header for API requests.
4. When the access token expires, client calls `POST /api/auth/refresh` with the refresh token (in body or HttpOnly cookie) to get a new access token.
5. On logout, client calls `POST /api/auth/logout`; the refresh token is deleted server-side.

## Integration Points with Existing API

The authentication middleware will be added to the existing API framework (e.g., Express, FastAPI, or similar). The following endpoints are integrated:

- `POST /api/auth/login` — authenticate and issue tokens.
- `POST /api/auth/refresh` — obtain a new access token from a valid refresh token.
- `POST /api/auth/logout` — invalidate the current refresh token.
- `GET /api/auth/me` — return the current user's profile information.
- All endpoints under `/api/v1/` (or similar) will run through the authentication middleware to require tokens.

### Middleware Flow
1. Check `Authorization` header for the token.
2. Verify JWT signature and expiry.
3. Load user from database (optional caching) by `sub` claim.
4. Attach user object to request context.
5. Reject with `401` if invalid or expired; `403` if user not active.

## Security Considerations
- Use HTTPS in production.
- Password hashing with bcrypt or argon2.
- JWT secret management: use environment variable or a secrets manager.
- If using cookies, set `Secure`, `HttpOnly`, and `SameSite` appropriately.
- Implement rate limiting on login and refresh endpoints.

## Future Enhancements
- Support OAuth2 for third‑party integrations.
- Add API key authentication for programmatic access.
- Multi-factor authentication (MFA) support.

---
This document covers the authentication architecture required by the acceptance criteria. Implementation details and code specific to the existing stack should follow the patterns described here.