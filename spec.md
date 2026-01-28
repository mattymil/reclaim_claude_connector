
# Claude Connector Specification: Reclaim.ai Task Creation

## Overview

This specification defines an AWS-based connector that enables Claude to create tasks in Reclaim.ai via their API. The connector will be implemented as an AWS Lambda function exposed through API Gateway, designed to integrate with Claude's MCP (Model Context Protocol) infrastructure with OAuth 2.0 authentication.

## All of this should be deplpyed via CDK.

## Architecture

```
Claude MCP → OAuth 2.0 Flow → API Gateway → Lambda Function → Reclaim.ai API
```

### Components

1. **API Gateway** - HTTPS endpoint for MCP requests
2. **Lambda Functions**
   - Authorization handler (OAuth flow)
   - Token handler (token exchange)
   - Task creation handler (core functionality)
3. **DynamoDB** - OAuth state and token storage
4. **Secrets Manager** - Reclaim.ai API credentials and OAuth client credentials
5. **CloudWatch** - Logging and monitoring

## OAuth 2.0 Implementation

### OAuth Endpoints Required

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/oauth/authorize` | GET | Initiates OAuth flow, redirects to consent |
| `/oauth/callback` | GET | Handles authorization code callback |
| `/oauth/token` | POST | Token exchange and refresh |
| `/oauth/revoke` | POST | Token revocation |

### OAuth Flow

```
1. Claude initiates connection
   → GET /oauth/authorize?client_id={claude_client_id}&redirect_uri={callback}&state={state}&code_challenge={pkce}

2. Connector validates request, generates authorization code
   → Redirect to redirect_uri with ?code={auth_code}&state={state}

3. Claude exchanges code for tokens
   → POST /oauth/token
     grant_type=authorization_code
     code={auth_code}
     code_verifier={pkce_verifier}
   
   ← Response:
     {
       "access_token": "...",
       "refresh_token": "...",
       "expires_in": 3600,
       "token_type": "Bearer"
     }

4. Claude makes API requests with access token
   → POST /mcp/reclaim/task
     Authorization: Bearer {access_token}

5. Token refresh when expired
   → POST /oauth/token
     grant_type=refresh_token
     refresh_token={refresh_token}
```

### OAuth Configuration

**Client Registration (stored in Secrets Manager):**
```json
{
  "claude_client_id": "reclaim-mcp-connector",
  "claude_client_secret": "generated-secure-secret",
  "allowed_redirect_uris": [
    "https://claude.ai/oauth/callback",
    "https://api.anthropic.com/oauth/callback"
  ],
  "scopes": ["tasks:write"],
  "token_expiry_seconds": 3600,
  "refresh_token_expiry_seconds": 2592000
}
```

### Token Storage (DynamoDB)

**Table: `reclaim-connector-oauth-tokens`**

| Attribute | Type | Description |
|-----------|------|-------------|
| `pk` | String | Partition key: `USER#{user_id}` |
| `sk` | String | Sort key: `TOKEN` |
| `access_token_hash` | String | SHA-256 hash of access token |
| `refresh_token_hash` | String | SHA-256 hash of refresh token |
| `expires_at` | Number | Unix timestamp of access token expiry |
| `refresh_expires_at` | Number | Unix timestamp of refresh token expiry |
| `scopes` | StringSet | Granted scopes |
| `created_at` | Number | Unix timestamp |
| `revoked` | Boolean | Whether token has been revoked |

**Table: `reclaim-connector-oauth-state`**

| Attribute | Type | Description |
|-----------|------|-------------|
| `state` | String | Partition key: OAuth state parameter |
| `code_challenge` | String | PKCE code challenge |
| `redirect_uri` | String | Validated redirect URI |
| `expires_at` | Number | TTL for automatic cleanup |

## Reclaim.ai API Integration

### Authentication

Reclaim.ai uses API key authentication. The API key should be stored in AWS Secrets Manager and retrieved at runtime.

**Header format:**
```
Authorization: Bearer {RECLAIM_API_KEY}
```

### Task Creation Endpoint

**Endpoint:** `POST https://api.app.reclaim.ai/api/tasks`

**Request Body Schema:**
```json
{
  "title": "string (required)",
  "notes": "string (optional)",
  "eventCategory": "string (required) - WORK, PERSONAL",
  "timeChunksRequired": "integer (required) - duration in 15-min chunks",
  "minChunkSize": "integer (required) - minimum block size in 15-min chunks",
  "maxChunkSize": "integer (required) - maximum block size in 15-min chunks", 
  "alwaysPrivate": "boolean (optional)",
  "due": "ISO 8601 datetime string (optional)",
  "snoozeUntil": "ISO 8601 datetime string (optional)",
  "priority": "string (required) - CRITICAL, HIGH, MEDIUM, LOW"
}
```

## MCP Tool Definition

### Tool: `create_reclaim_task`

**Description:** Create a new task in Reclaim.ai that will be automatically scheduled.

**Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| title | string | Yes | Task title |
| duration_minutes | integer | Yes | Total time needed (converted to 15-min chunks). Also sets min/max block size to match. |
| priority | string | Yes | CRITICAL, HIGH, MEDIUM, or LOW |
| category | string | Yes | WORK or PERSONAL |
| notes | string | No | Task description/notes |
| due | string | No | Due date in ISO 8601 format |
| private | boolean | No | Whether to mark calendar events as private |

**Parameter Transformation:**
- `duration_minutes` → `timeChunksRequired` (divide by 15)
- `duration_minutes` → `minChunkSize` (divide by 15, mirrors duration)
- `duration_minutes` → `maxChunkSize` (divide by 15, mirrors duration)
- `priority` → `priority` (pass through)
- `category` → `eventCategory` (pass through)

**Response:**
```json
{
  "success": true,
  "task": {
    "id": "string",
    "title": "string",
    "status": "string",
    "created": "ISO 8601 datetime"
  }
}
```

## Lambda Function Structure

### Authorization Handler (`/oauth/authorize`)

```
function authorizeHandler(event):
    1. Extract query parameters:
       - client_id (required)
       - redirect_uri (required)
       - state (required)
       - code_challenge (required for PKCE)
       - code_challenge_method (must be S256)
       - scope (optional, defaults to tasks:write)
    
    2. Validate client_id against registered clients
    3. Validate redirect_uri against allowed URIs
    4. Generate authorization code
    5. Store state + code_challenge in DynamoDB with TTL
    6. Redirect to redirect_uri with code and state
```

### Token Handler (`/oauth/token`)

```
function tokenHandler(event):
    1. Parse request body (form-encoded)
    2. Switch on grant_type:
    
       Case "authorization_code":
         - Validate code against stored state
         - Validate code_verifier against code_challenge (PKCE)
         - Generate access_token and refresh_token
         - Store token hashes in DynamoDB
         - Return tokens with expiry
       
       Case "refresh_token":
         - Validate refresh_token hash exists and not expired
         - Generate new access_token (optionally new refresh_token)
         - Update DynamoDB
         - Return new tokens
    
    3. Return error for invalid requests
```

### Task Handler (`/mcp/reclaim/task`)

```
function taskHandler(event):
    1. Extract Bearer token from Authorization header
    2. Validate token:
       - Hash token and lookup in DynamoDB
       - Check expiry
       - Check not revoked
       - Verify scope includes tasks:write
    3. If invalid, return 401
    
    4. Parse and validate request body:
       - title (string, non-empty)
       - duration_minutes (integer, positive, divisible by 15)
       - priority (enum: CRITICAL, HIGH, MEDIUM, LOW)
       - category (enum: WORK, PERSONAL)
    
    5. Retrieve Reclaim API key from Secrets Manager
    6. Transform parameters to Reclaim API format
    7. POST to Reclaim.ai API
    8. Return formatted MCP response
```

### Error Handling

| Scenario | HTTP Status | Response |
|----------|-------------|----------|
| Missing/invalid OAuth token | 401 | `{"error": "unauthorized", "error_description": "..."}` |
| Token expired | 401 | `{"error": "token_expired", "error_description": "..."}` |
| Insufficient scope | 403 | `{"error": "insufficient_scope", "error_description": "..."}` |
| Missing required field | 400 | `{"error": "{field} is required"}` |
| Invalid duration | 400 | `{"error": "duration_minutes must be divisible by 15"}` |
| Invalid priority value | 400 | `{"error": "priority must be CRITICAL, HIGH, MEDIUM, or LOW"}` |
| Invalid category value | 400 | `{"error": "category must be WORK or PERSONAL"}` |
| Reclaim API error | 502 | `{"error": "Reclaim API error: {details}"}` |
| Rate limited | 429 | `{"error": "Rate limited, retry after {seconds}s"}` |

## AWS Infrastructure

### Lambda Configuration

**Authorization Lambda:**
- **Function name:** `reclaim-connector-oauth-authorize`
- **Runtime:** Node.js 20.x
- **Memory:** 256 MB
- **Timeout:** 10 seconds

**Token Lambda:**
- **Function name:** `reclaim-connector-oauth-token`
- **Runtime:** Node.js 20.x
- **Memory:** 256 MB
- **Timeout:** 10 seconds

**Task Lambda:**
- **Function name:** `reclaim-connector-task`
- **Runtime:** Node.js 20.x
- **Memory:** 256 MB
- **Timeout:** 30 seconds
- **Environment Variables:**
  - `RECLAIM_SECRET_NAME` - Secrets Manager secret name
  - `OAUTH_TABLE_NAME` - DynamoDB tokens table name

### DynamoDB Tables

**Tokens Table:**
```
Table Name: reclaim-connector-oauth-tokens
Partition Key: pk (String)
Sort Key: sk (String)
Billing: On-demand
TTL Attribute: expires_at
```

**State Table:**
```
Table Name: reclaim-connector-oauth-state
Partition Key: state (String)
Billing: On-demand
TTL Attribute: expires_at
```

### IAM Permissions

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": [
        "arn:aws:secretsmanager:{region}:{account}:secret:reclaim-api-key-*",
        "arn:aws:secretsmanager:{region}:{account}:secret:reclaim-connector-oauth-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:{region}:{account}:table/reclaim-connector-oauth-tokens",
        "arn:aws:dynamodb:{region}:{account}:table/reclaim-connector-oauth-state"
      ]
    }
  ]
}
```

### API Gateway Configuration

- **Type:** HTTP API
- **Routes:**
  - `GET /oauth/authorize` → Authorization Lambda
  - `POST /oauth/token` → Token Lambda
  - `POST /oauth/revoke` → Token Lambda
  - `POST /mcp/reclaim/task` → Task Lambda
- **CORS:** Enabled for Claude origins

## Deployment Guide

### Prerequisites

- AWS CLI installed and configured
- Node.js 20.x installed locally
- Reclaim.ai API key

### Step 1: Create DynamoDB Tables

```bash
# Tokens table
aws dynamodb create-table \
  --table-name reclaim-connector-oauth-tokens \
  --attribute-definitions \
    AttributeName=pk,AttributeType=S \
    AttributeName=sk,AttributeType=S \
  --key-schema \
    AttributeName=pk,KeyType=HASH \
    AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST

# Enable TTL on tokens table
aws dynamodb update-time-to-live \
  --table-name reclaim-connector-oauth-tokens \
  --time-to-live-specification Enabled=true,AttributeName=expires_at

# State table
aws dynamodb create-table \
  --table-name reclaim-connector-oauth-state \
  --attribute-definitions \
    AttributeName=state,AttributeType=S \
  --key-schema \
    AttributeName=state,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# Enable TTL on state table
aws dynamodb update-time-to-live \
  --table-name reclaim-connector-oauth-state \
  --time-to-live-specification Enabled=true,AttributeName=expires_at
```

### Step 2: Store Secrets

```bash
# Reclaim API key
aws secretsmanager create-secret \
  --name reclaim-api-key \
  --description "Reclaim.ai API key for Claude MCP connector" \
  --secret-string "YOUR_RECLAIM_API_KEY_HERE"

# OAuth client configuration
aws secretsmanager create-secret \
  --name reclaim-connector-oauth-config \
  --description "OAuth client configuration for Claude MCP connector" \
  --secret-string '{
    "claude_client_id": "reclaim-mcp-connector",
    "claude_client_secret": "GENERATE_A_SECURE_SECRET_HERE",
    "allowed_redirect_uris": [
      "https://claude.ai/oauth/callback",
      "https://api.anthropic.com/oauth/callback"
    ],
    "scopes": ["tasks:write"],
    "token_expiry_seconds": 3600,
    "refresh_token_expiry_seconds": 2592000
  }'
```

### Step 3: Create IAM Role

Create `trust-policy.json`:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
```

Create `lambda-policy.json` (replace `{region}` and `{account}`):
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:*"
    },
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": [
        "arn:aws:secretsmanager:{region}:{account}:secret:reclaim-api-key-*",
        "arn:aws:secretsmanager:{region}:{account}:secret:reclaim-connector-oauth-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query"
      ],
      "Resource": [
        "arn:aws:dynamodb:{region}:{account}:table/reclaim-connector-oauth-tokens",
        "arn:aws:dynamodb:{region}:{account}:table/reclaim-connector-oauth-state"
      ]
    }
  ]
}
```

```bash
aws iam create-role \
  --role-name reclaim-connector-lambda-role \
  --assume-role-policy-document file://trust-policy.json

aws iam put-role-policy \
  --role-name reclaim-connector-lambda-role \
  --policy-name reclaim-connector-policy \
  --policy-document file://lambda-policy.json
```

### Step 4: Deploy Lambda Functions

```bash
# Package and deploy each function
# (Assuming separate directories for each handler)

# Authorization handler
cd oauth-authorize && zip -r ../authorize.zip . && cd ..
aws lambda create-function \
  --function-name reclaim-connector-oauth-authorize \
  --runtime nodejs20.x \
  --role arn:aws:iam::{account}:role/reclaim-connector-lambda-role \
  --handler index.handler \
  --zip-file fileb://authorize.zip \
  --timeout 10 \
  --memory-size 256 \
  --environment "Variables={OAUTH_SECRET_NAME=reclaim-connector-oauth-config,STATE_TABLE_NAME=reclaim-connector-oauth-state}"

# Token handler
cd oauth-token && zip -r ../token.zip . && cd ..
aws lambda create-function \
  --function-name reclaim-connector-oauth-token \
  --runtime nodejs20.x \
  --role arn:aws:iam::{account}:role/reclaim-connector-lambda-role \
  --handler index.handler \
  --zip-file fileb://token.zip \
  --timeout 10 \
  --memory-size 256 \
  --environment "Variables={OAUTH_SECRET_NAME=reclaim-connector-oauth-config,TOKENS_TABLE_NAME=reclaim-connector-oauth-tokens,STATE_TABLE_NAME=reclaim-connector-oauth-state}"

# Task handler
cd task && zip -r ../task.zip . && cd ..
aws lambda create-function \
  --function-name reclaim-connector-task \
  --runtime nodejs20.x \
  --role arn:aws:iam::{account}:role/reclaim-connector-lambda-role \
  --handler index.handler \
  --zip-file fileb://task.zip \
  --timeout 30 \
  --memory-size 256 \
  --environment "Variables={RECLAIM_SECRET_NAME=reclaim-api-key,TOKENS_TABLE_NAME=reclaim-connector-oauth-tokens}"
```

### Step 5: Create API Gateway

```bash
# Create HTTP API
aws apigatewayv2 create-api \
  --name reclaim-mcp-api \
  --protocol-type HTTP \
  --cors-configuration AllowOrigins="*",AllowMethods="GET,POST",AllowHeaders="Content-Type,Authorization"

# Note the ApiId, then create integrations and routes for each Lambda
# (See previous deployment section for detailed commands)
```

### Step 6: Register with Claude MCP

Provide Anthropic with:
- **Authorization URL:** `https://{api-id}.execute-api.{region}.amazonaws.com/prod/oauth/authorize`
- **Token URL:** `https://{api-id}.execute-api.{region}.amazonaws.com/prod/oauth/token`
- **API Endpoint:** `https://{api-id}.execute-api.{region}.amazonaws.com/prod/mcp/reclaim/task`
- **Client ID:** `reclaim-mcp-connector`
- **Scopes:** `tasks:write`

## Testing

### Test OAuth Flow

```bash
# 1. Initiate authorization (browser)
https://{api-id}.execute-api.{region}.amazonaws.com/prod/oauth/authorize?client_id=reclaim-mcp-connector&redirect_uri=https://claude.ai/oauth/callback&state=test123&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256

# 2. Exchange code for token
curl -X POST https://{api-id}.execute-api.{region}.amazonaws.com/prod/oauth/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=authorization_code&code={auth_code}&code_verifier={verifier}&redirect_uri=https://claude.ai/oauth/callback"
```

### Test Task Creation

```bash
curl -X POST https://{api-id}.execute-api.{region}.amazonaws.com/prod/mcp/reclaim/task \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {access_token}" \
  -d '{
    "title": "Review Q1 reports",
    "duration_minutes": 60,
    "priority": "HIGH",
    "category": "WORK",
    "notes": "Focus on revenue trends",
    "due": "2026-01-31T17:00:00Z"
  }'
```

## Security Considerations

1. **PKCE Required** - All authorization requests must include code_challenge
2. **Token Hashing** - Tokens stored as SHA-256 hashes, never plaintext
3. **Short-lived Access Tokens** - 1 hour expiry by default
4. **Refresh Token Rotation** - Optional: issue new refresh token on each use
5. **State Parameter** - Required to prevent CSRF
6. **Redirect URI Validation** - Strict allowlist matching

## Future Enhancements

- List tasks
- Update task status
- Delete tasks
- Sync with task completion events
- Support for recurring tasks
- Allow separate min/max block sizes for chunked scheduling
- Additional OAuth scopes for read operations

---

Ready for implementation. Want me to write the Lambda function code?
