import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getOAuthConfig,
  saveAuthCode,
  generateAuthCode,
  redirectResponse,
  errorResponse,
} from '../shared/utils';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    const params = event.queryStringParameters || {};

    // Extract required parameters
    const clientId = params.client_id;
    const redirectUri = params.redirect_uri;
    const state = params.state;
    const codeChallenge = params.code_challenge;
    const codeChallengeMethod = params.code_challenge_method;
    const scope = params.scope || 'tasks:write';

    // Validate required parameters
    if (!clientId) {
      return errorResponse(400, 'invalid_request', 'client_id is required');
    }
    if (!redirectUri) {
      return errorResponse(400, 'invalid_request', 'redirect_uri is required');
    }
    if (!state) {
      return errorResponse(400, 'invalid_request', 'state is required');
    }
    if (!codeChallenge) {
      return errorResponse(400, 'invalid_request', 'code_challenge is required (PKCE)');
    }
    if (codeChallengeMethod !== 'S256') {
      return errorResponse(400, 'invalid_request', 'code_challenge_method must be S256');
    }

    // Load OAuth config and validate
    const config = await getOAuthConfig();

    // Validate client_id
    if (clientId !== config.claude_client_id) {
      return errorResponse(400, 'invalid_client', 'Unknown client_id');
    }

    // Validate redirect_uri
    if (!config.allowed_redirect_uris.includes(redirectUri)) {
      return errorResponse(400, 'invalid_request', 'redirect_uri not allowed');
    }

    // Validate scope
    const requestedScopes = scope.split(' ');
    for (const s of requestedScopes) {
      if (!config.scopes.includes(s)) {
        return errorResponse(400, 'invalid_scope', `Scope '${s}' not allowed`);
      }
    }

    // Generate authorization code
    const authCode = generateAuthCode();

    // Save auth code with PKCE challenge for later verification
    await saveAuthCode(authCode, state, codeChallenge, redirectUri, scope);

    // Redirect back to client with authorization code
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set('code', authCode);
    redirectUrl.searchParams.set('state', state);

    console.log(`Authorization code issued for client ${clientId}, redirecting to ${redirectUri}`);

    return redirectResponse(redirectUrl.toString());
  } catch (error) {
    console.error('Authorization error:', error);
    return errorResponse(500, 'server_error', 'Internal server error');
  }
};
