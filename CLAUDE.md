# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS-based connector that enables Claude to create tasks in Reclaim.ai via OAuth 2.0 authenticated API endpoints. Designed as an MCP (Model Context Protocol) integration.

**Status:** Specification complete (`spec.md`), implementation pending.

## Architecture

```
Claude MCP → OAuth 2.0 Flow → API Gateway → Lambda Functions → Reclaim.ai API
```

### Components

- **API Gateway** - HTTP API with CORS for Claude origins
- **Lambda Functions** (Node.js 20.x):
  - `reclaim-connector-oauth-authorize` - Initiates OAuth flow with PKCE
  - `reclaim-connector-oauth-token` - Token exchange and refresh
  - `reclaim-connector-task` - Creates tasks in Reclaim.ai
- **DynamoDB Tables**:
  - `reclaim-connector-oauth-tokens` - Stores hashed tokens (pk/sk keys, TTL on `expires_at`)
  - `reclaim-connector-oauth-state` - OAuth state and PKCE challenges (TTL cleanup)
- **Secrets Manager** - Reclaim API key and OAuth client config

## Key Implementation Details

### OAuth Flow

PKCE is required for all authorization requests. Tokens are stored as SHA-256 hashes, never plaintext.

### Parameter Transformation (MCP → Reclaim API)

```
duration_minutes → timeChunksRequired (divide by 15)
duration_minutes → minChunkSize (divide by 15)
duration_minutes → maxChunkSize (divide by 15)
category → eventCategory
```

`duration_minutes` must be divisible by 15.

### Environment Variables

- `RECLAIM_SECRET_NAME` - Secrets Manager secret for Reclaim API key
- `OAUTH_SECRET_NAME` - Secrets Manager secret for OAuth config
- `TOKENS_TABLE_NAME` - DynamoDB tokens table name
- `STATE_TABLE_NAME` - DynamoDB state table name

## Build & Deploy Commands

Infrastructure should be deployed via AWS CDK:

```bash
npm install
npm run build
npm run deploy    # Deploy CDK stack to AWS
npm run test
```

## API Endpoints

| Endpoint | Method | Handler |
|----------|--------|---------|
| `/oauth/authorize` | GET | Authorization Lambda |
| `/oauth/callback` | GET | Authorization Lambda |
| `/oauth/token` | POST | Token Lambda |
| `/oauth/revoke` | POST | Token Lambda |
| `/mcp/reclaim/task` | POST | Task Lambda |

## Reference

Full specification including OAuth config, DynamoDB schemas, IAM permissions, and testing commands is in `spec.md`.
