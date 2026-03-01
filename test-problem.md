## Problem: Design a rate limiter for an HTTP API

Design a rate limiter for a REST API that:
- Limits requests per user (by API key)
- Supports different rate limits for different endpoints
- Returns proper HTTP 429 responses with Retry-After header
- Should work in a distributed environment (multiple server instances)
- Must be efficient and not add significant latency

What algorithm would you use? What storage backend? How would you handle edge cases like clock skew, burst traffic, and graceful degradation?

Provide a concrete implementation plan with code examples.
