import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { parse as parseQueryString } from 'querystring';
import {
  getOAuthConfig,
  getAuthCode,
  deleteAuthCode,
  verifyPkce,
  generateToken,
  saveTokens,
  getTokenByAccessToken,
  getTokenByRefreshToken,
  revokeToken,
  jsonResponse,
  errorResponse,
} from '../shared/utils';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    // Check if this is a revoke request
    if (event.rawPath?.endsWith('/revoke')) {
      return handleRevoke(event);
    }

    // Parse form-encoded body
    const body = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf-8')
      : event.body || '';
    const params = parseQueryString(body) as Record<string, string>;

    const grantType = params.grant_type;

    if (grantType === 'authorization_code') {
      return handleAuthorizationCode(params);
    } else if (grantType === 'refresh_token') {
      return handleRefreshToken(params);
    } else {
      return errorResponse(400, 'unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    }
  } catch (error) {
    console.error('Token error:', error);
    return errorResponse(500, 'server_error', 'Internal server error');
  }
};

async function handleAuthorizationCode(params: Record<string, string>): Promise<APIGatewayProxyResultV2> {
  const code = params.code;
  const codeVerifier = params.code_verifier;
  const redirectUri = params.redirect_uri;

  // Validate required parameters
  if (!code) {
    return errorResponse(400, 'invalid_request', 'code is required');
  }
  if (!codeVerifier) {
    return errorResponse(400, 'invalid_request', 'code_verifier is required');
  }
  if (!redirectUri) {
    return errorResponse(400, 'invalid_request', 'redirect_uri is required');
  }

  // Look up the authorization code
  const authCodeData = await getAuthCode(code);
  if (!authCodeData) {
    return errorResponse(400, 'invalid_grant', 'Invalid or expired authorization code');
  }

  // Verify redirect_uri matches
  if (authCodeData.redirect_uri !== redirectUri) {
    return errorResponse(400, 'invalid_grant', 'redirect_uri mismatch');
  }

  // Verify PKCE
  if (!verifyPkce(codeVerifier, authCodeData.code_challenge)) {
    return errorResponse(400, 'invalid_grant', 'Invalid code_verifier');
  }

  // Delete the auth code (one-time use)
  await deleteAuthCode(code);

  // Load config for token expiry settings
  const config = await getOAuthConfig();

  // Generate tokens
  const accessToken = generateToken();
  const refreshToken = generateToken();

  // Generate a user ID (in a real system, this would come from user authentication)
  // For this connector, we use a hash of the code to create a consistent user ID
  const userId = `claude-${Date.now()}`;

  // Save tokens
  const scopes = authCodeData.scope.split(' ');
  await saveTokens(
    userId,
    accessToken,
    refreshToken,
    scopes,
    config.token_expiry_seconds,
    config.refresh_token_expiry_seconds
  );

  console.log(`Tokens issued for user ${userId}`);

  return jsonResponse(200, {
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: config.token_expiry_seconds,
    refresh_token: refreshToken,
    scope: authCodeData.scope,
  });
}

async function handleRefreshToken(params: Record<string, string>): Promise<APIGatewayProxyResultV2> {
  const refreshToken = params.refresh_token;

  if (!refreshToken) {
    return errorResponse(400, 'invalid_request', 'refresh_token is required');
  }

  // Look up the refresh token
  const tokenData = await getTokenByRefreshToken(refreshToken);
  if (!tokenData) {
    return errorResponse(400, 'invalid_grant', 'Invalid refresh token');
  }

  // Check if refresh token is expired
  const now = Math.floor(Date.now() / 1000);
  if (tokenData.refresh_expires_at < now) {
    return errorResponse(400, 'invalid_grant', 'Refresh token expired');
  }

  // Revoke old tokens
  await revokeToken(tokenData.pk);

  // Load config
  const config = await getOAuthConfig();

  // Generate new tokens
  const newAccessToken = generateToken();
  const newRefreshToken = generateToken();

  // Extract user ID from pk (format: USER#userId)
  const userId = tokenData.pk.replace('USER#', '');

  // Save new tokens
  await saveTokens(
    userId,
    newAccessToken,
    newRefreshToken,
    tokenData.scopes,
    config.token_expiry_seconds,
    config.refresh_token_expiry_seconds
  );

  console.log(`Tokens refreshed for user ${userId}`);

  return jsonResponse(200, {
    access_token: newAccessToken,
    token_type: 'Bearer',
    expires_in: config.token_expiry_seconds,
    refresh_token: newRefreshToken,
    scope: tokenData.scopes.join(' '),
  });
}

async function handleRevoke(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  // Parse form-encoded body
  const body = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf-8')
    : event.body || '';
  const params = parseQueryString(body) as Record<string, string>;

  const token = params.token;
  const tokenTypeHint = params.token_type_hint;

  if (!token) {
    return errorResponse(400, 'invalid_request', 'token is required');
  }

  // Try to find and revoke the token
  // Check as refresh token first (more common for revocation)
  let tokenData = await getTokenByRefreshToken(token);
  if (tokenData) {
    await revokeToken(tokenData.pk);
    console.log(`Token revoked for user ${tokenData.pk}`);
    return jsonResponse(200, {});
  }

  // If not found as refresh token and hint says access_token, try that
  if (tokenTypeHint === 'access_token') {
    const accessTokenData = await getTokenByAccessToken(token);
    if (accessTokenData) {
      await revokeToken(accessTokenData.pk);
      console.log(`Token revoked for user ${accessTokenData.pk}`);
      return jsonResponse(200, {});
    }
  }

  // Per RFC 7009, return 200 even if token not found
  return jsonResponse(200, {});
}
