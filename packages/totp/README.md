# @rp/totp

Time-based one-time passwords (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits), as authenticator
apps make them: the Owner's second factor on the restaurant PC (AUTH-006) and the mandatory MFA of
vendor staff in the Control Plane (VCP-001, SEC-018). A code is checked against the current step and
one either side, and never accepted twice.

Built by: P0-11 (in the server), moved here in P7-02a.
