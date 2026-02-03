import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { saveInboxItem, getSecret, jsonResponse, errorResponse } from '../shared/utils';

const API_KEY_SECRET_NAME = process.env.API_KEY_SECRET_NAME!;
const INBOX_USER_ID = process.env.INBOX_USER_ID || 'public-inbox';

interface InboxRequest {
  title: string;
  notes?: string;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log('Public inbox request:', JSON.stringify({
    method: event.httpMethod,
    path: event.path,
    headers: { ...event.headers, 'x-api-key': event.headers['x-api-key'] ? '[REDACTED]' : undefined },
  }));

  // Validate API key
  const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'];
  if (!apiKey) {
    return errorResponse(401, 'unauthorized', 'Missing X-API-Key header');
  }

  try {
    const expectedApiKey = await getSecret(API_KEY_SECRET_NAME);
    if (apiKey !== expectedApiKey) {
      return errorResponse(401, 'unauthorized', 'Invalid API key');
    }
  } catch (error) {
    console.error('Error validating API key:', error);
    return errorResponse(500, 'server_error', 'Failed to validate API key');
  }

  // Parse request body
  let body: InboxRequest;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return errorResponse(400, 'invalid_request', 'Invalid JSON body');
  }

  // Validate required fields
  if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
    return errorResponse(400, 'invalid_request', 'Missing or empty title field');
  }

  // Validate notes if provided
  if (body.notes !== undefined && typeof body.notes !== 'string') {
    return errorResponse(400, 'invalid_request', 'Notes must be a string');
  }

  try {
    const result = await saveInboxItem(
      INBOX_USER_ID,
      body.title.trim(),
      body.notes?.trim() || undefined
    );

    console.log(`Saved inbox item: ${result.id}`);

    return jsonResponse(201, {
      success: true,
      id: result.id,
    });
  } catch (error) {
    console.error('Error saving inbox item:', error);
    return errorResponse(500, 'server_error', 'Failed to save inbox item');
  }
};
