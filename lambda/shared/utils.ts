import { createHash, randomBytes } from 'crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const dynamoClient = new DynamoDBClient({});
export const docClient = DynamoDBDocumentClient.from(dynamoClient);

const secretsClient = new SecretsManagerClient({});

// Cache for secrets
const secretsCache: Record<string, { value: string; expiry: number }> = {};
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getSecret(secretName: string): Promise<string> {
  const now = Date.now();
  const cached = secretsCache[secretName];
  if (cached && cached.expiry > now) {
    return cached.value;
  }

  const response = await secretsClient.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  const value = response.SecretString || '';
  secretsCache[secretName] = { value, expiry: now + CACHE_TTL };
  return value;
}

export async function getOAuthConfig(): Promise<OAuthConfig> {
  const secretName = process.env.OAUTH_SECRET_NAME!;
  const secretString = await getSecret(secretName);
  return JSON.parse(secretString);
}

export interface OAuthConfig {
  claude_client_id: string;
  claude_client_secret: string;
  allowed_redirect_uris: string[];
  scopes: string[];
  token_expiry_seconds: number;
  refresh_token_expiry_seconds: number;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function generateAuthCode(): string {
  return randomBytes(16).toString('hex');
}

// PKCE verification
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const hash = createHash('sha256').update(codeVerifier).digest('base64url');
  return hash === codeChallenge;
}

// DynamoDB helpers for state table
export async function saveOAuthState(
  state: string,
  codeChallenge: string,
  redirectUri: string,
  scope: string
): Promise<void> {
  const tableName = process.env.STATE_TABLE_NAME!;
  const expiresAt = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        state,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
        scope,
        expires_at: expiresAt,
      },
    })
  );
}

export async function getOAuthState(state: string): Promise<{
  code_challenge: string;
  redirect_uri: string;
  scope: string;
} | null> {
  const tableName = process.env.STATE_TABLE_NAME!;
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { state },
    })
  );

  if (!result.Item) return null;

  // Check if expired
  if (result.Item.expires_at < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return {
    code_challenge: result.Item.code_challenge,
    redirect_uri: result.Item.redirect_uri,
    scope: result.Item.scope,
  };
}

export async function deleteOAuthState(state: string): Promise<void> {
  const tableName = process.env.STATE_TABLE_NAME!;
  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { state },
    })
  );
}

// DynamoDB helpers for tokens table
export async function saveTokens(
  userId: string,
  accessToken: string,
  refreshToken: string,
  scopes: string[],
  accessExpiresIn: number,
  refreshExpiresIn: number
): Promise<void> {
  const tableName = process.env.TOKENS_TABLE_NAME!;
  const now = Math.floor(Date.now() / 1000);

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        pk: `USER#${userId}`,
        sk: 'TOKEN',
        access_token_hash: hashToken(accessToken),
        refresh_token_hash: hashToken(refreshToken),
        expires_at: now + accessExpiresIn,
        refresh_expires_at: now + refreshExpiresIn,
        scopes,
        created_at: now,
        revoked: false,
      },
    })
  );
}

export async function getTokenByAccessToken(accessToken: string): Promise<{
  pk: string;
  scopes: string[];
  expires_at: number;
  revoked: boolean;
} | null> {
  const tableName = process.env.TOKENS_TABLE_NAME!;
  const accessTokenHash = hashToken(accessToken);

  // We need to scan since we're looking up by token hash, not by pk
  // In production, consider adding a GSI on access_token_hash
  const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

  const result = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'access_token_hash = :hash AND revoked = :revoked',
      ExpressionAttributeValues: {
        ':hash': accessTokenHash,
        ':revoked': false,
      },
    })
  );

  if (!result.Items || result.Items.length === 0) return null;

  const item = result.Items[0];
  return {
    pk: item.pk,
    scopes: item.scopes,
    expires_at: item.expires_at,
    revoked: item.revoked,
  };
}

export async function getTokenByRefreshToken(refreshToken: string): Promise<{
  pk: string;
  scopes: string[];
  refresh_expires_at: number;
  revoked: boolean;
} | null> {
  const tableName = process.env.TOKENS_TABLE_NAME!;
  const refreshTokenHash = hashToken(refreshToken);

  const { ScanCommand } = await import('@aws-sdk/lib-dynamodb');

  const result = await docClient.send(
    new ScanCommand({
      TableName: tableName,
      FilterExpression: 'refresh_token_hash = :hash AND revoked = :revoked',
      ExpressionAttributeValues: {
        ':hash': refreshTokenHash,
        ':revoked': false,
      },
    })
  );

  if (!result.Items || result.Items.length === 0) return null;

  const item = result.Items[0];
  return {
    pk: item.pk,
    scopes: item.scopes,
    refresh_expires_at: item.refresh_expires_at,
    revoked: item.revoked,
  };
}

export async function revokeToken(pk: string): Promise<void> {
  const tableName = process.env.TOKENS_TABLE_NAME!;
  const { UpdateCommand } = await import('@aws-sdk/lib-dynamodb');

  await docClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { pk, sk: 'TOKEN' },
      UpdateExpression: 'SET revoked = :revoked',
      ExpressionAttributeValues: {
        ':revoked': true,
      },
    })
  );
}

// Auth code storage (temporary, stored in state table with different key pattern)
export async function saveAuthCode(
  code: string,
  state: string,
  codeChallenge: string,
  redirectUri: string,
  scope: string
): Promise<void> {
  const tableName = process.env.STATE_TABLE_NAME!;
  const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes

  await docClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        state: `CODE#${code}`,
        code_challenge: codeChallenge,
        redirect_uri: redirectUri,
        scope,
        original_state: state,
        expires_at: expiresAt,
      },
    })
  );
}

export async function getAuthCode(code: string): Promise<{
  code_challenge: string;
  redirect_uri: string;
  scope: string;
} | null> {
  const tableName = process.env.STATE_TABLE_NAME!;
  const result = await docClient.send(
    new GetCommand({
      TableName: tableName,
      Key: { state: `CODE#${code}` },
    })
  );

  if (!result.Item) return null;

  if (result.Item.expires_at < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return {
    code_challenge: result.Item.code_challenge,
    redirect_uri: result.Item.redirect_uri,
    scope: result.Item.scope,
  };
}

export async function deleteAuthCode(code: string): Promise<void> {
  const tableName = process.env.STATE_TABLE_NAME!;
  await docClient.send(
    new DeleteCommand({
      TableName: tableName,
      Key: { state: `CODE#${code}` },
    })
  );
}

// Response helpers
export function jsonResponse(statusCode: number, body: object): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export function redirectResponse(location: string): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return {
    statusCode: 302,
    headers: {
      Location: location,
      'Cache-Control': 'no-store',
    },
    body: '',
  };
}

export function errorResponse(
  statusCode: number,
  error: string,
  description: string
): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
} {
  return jsonResponse(statusCode, { error, error_description: description });
}
