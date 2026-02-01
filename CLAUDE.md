# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

AWS-based connector that enables Claude to create tasks in Reclaim.ai via OAuth 2.0 authenticated API endpoints. Designed as an MCP (Model Context Protocol) integration.

## Architecture

```
Claude MCP → OAuth 2.0 Flow → API Gateway → Lambda Functions → Reclaim.ai API
```

### Components

- **API Gateway** - HTTP API with CORS for Claude origins
- **Lambda Functions** (Node.js 20.x):
  - `reclaim-connector-oauth-authorize` - Initiates OAuth flow with PKCE
  - `reclaim-connector-oauth-token` - Token exchange and refresh
  - `reclaim-connector-mcp` - MCP JSON-RPC handler for all tools
  - `reclaim-connector-task` - Legacy REST endpoint for task creation
- **DynamoDB Tables**:
  - `reclaim-connector-oauth-tokens` - Stores hashed tokens (pk/sk keys, TTL on `expires_at`)
  - `reclaim-connector-oauth-state` - OAuth state and PKCE challenges (TTL cleanup)
  - `reclaim-connector-inbox` - GTD inbox items
  - `reclaim-connector-otter-processed` - Processed Otter meeting tracking
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
priority: CRITICAL→P1, HIGH→P2, MEDIUM→P3, LOW→P4
```

`duration_minutes` must be divisible by 15.

### Environment Variables (set by CDK)

- `RECLAIM_SECRET_NAME` - Secrets Manager secret for Reclaim API key
- `OAUTH_SECRET_NAME` - Secrets Manager secret for OAuth config
- `TOKENS_TABLE_NAME` - DynamoDB tokens table name
- `STATE_TABLE_NAME` - DynamoDB state table name
- `INBOX_TABLE_NAME` - DynamoDB inbox table name
- `OTTER_PROCESSED_TABLE_NAME` - DynamoDB Otter processed table name

## Build & Deploy Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript
npm run test         # Run tests

# CDK commands
cdk synth            # Generate CloudFormation template
cdk diff             # Preview changes
cdk deploy           # Deploy to AWS
```

## API Endpoints

| Endpoint | Method | Handler |
|----------|--------|---------|
| `/oauth/authorize` | GET | Authorization Lambda |
| `/oauth/token` | POST | Token Lambda |
| `/oauth/revoke` | POST | Token Lambda |
| `/mcp` | POST | MCP Lambda (JSON-RPC) |
| `/mcp/reclaim/task` | POST | Task Lambda (legacy) |

