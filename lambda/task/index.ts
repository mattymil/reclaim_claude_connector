import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getSecret,
  getTokenByAccessToken,
  jsonResponse,
  errorResponse,
} from '../shared/utils';

interface TaskRequest {
  title: string;
  duration_minutes: number;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  category: 'WORK' | 'PERSONAL';
  notes?: string;
  due?: string;
  private?: boolean;
}

interface ReclaimTaskRequest {
  title: string;
  notes?: string;
  eventCategory: string;
  timeChunksRequired: number;
  minChunkSize: number;
  maxChunkSize: number;
  priority: string;
  alwaysPrivate?: boolean;
  due?: string;
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  try {
    // Extract and validate Bearer token
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return errorResponse(401, 'unauthorized', 'Bearer token required');
    }

    const accessToken = authHeader.substring(7);

    // Validate token
    const tokenData = await getTokenByAccessToken(accessToken);
    if (!tokenData) {
      return errorResponse(401, 'unauthorized', 'Invalid access token');
    }

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (tokenData.expires_at < now) {
      return errorResponse(401, 'token_expired', 'Access token has expired');
    }

    // Check scope
    if (!tokenData.scopes.includes('tasks:write')) {
      return errorResponse(403, 'insufficient_scope', 'Token does not have tasks:write scope');
    }

    // Parse request body
    let body: TaskRequest;
    try {
      const rawBody = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf-8')
        : event.body || '{}';
      body = JSON.parse(rawBody);
    } catch {
      return errorResponse(400, 'invalid_request', 'Invalid JSON body');
    }

    // Validate required fields
    if (!body.title || typeof body.title !== 'string' || body.title.trim() === '') {
      return errorResponse(400, 'invalid_request', 'title is required and must be a non-empty string');
    }

    if (typeof body.duration_minutes !== 'number' || body.duration_minutes <= 0) {
      return errorResponse(400, 'invalid_request', 'duration_minutes is required and must be a positive number');
    }

    if (body.duration_minutes % 15 !== 0) {
      return errorResponse(400, 'invalid_request', 'duration_minutes must be divisible by 15');
    }

    const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    if (!body.priority || !validPriorities.includes(body.priority)) {
      return errorResponse(400, 'invalid_request', `priority must be one of: ${validPriorities.join(', ')}`);
    }

    // Map our priority values to Reclaim API values
    const priorityMap: Record<string, string> = {
      'CRITICAL': 'P1',
      'HIGH': 'P2',
      'MEDIUM': 'P3',
      'LOW': 'P4',
    };

    const validCategories = ['WORK', 'PERSONAL'];
    if (!body.category || !validCategories.includes(body.category)) {
      return errorResponse(400, 'invalid_request', `category must be one of: ${validCategories.join(', ')}`);
    }

    // Validate due date format if provided
    if (body.due) {
      const dueDate = new Date(body.due);
      if (isNaN(dueDate.getTime())) {
        return errorResponse(400, 'invalid_request', 'due must be a valid ISO 8601 datetime');
      }
    }

    // Transform to Reclaim API format
    const timeChunks = body.duration_minutes / 15;
    const reclaimRequest: ReclaimTaskRequest = {
      title: body.title.trim(),
      eventCategory: body.category,
      timeChunksRequired: timeChunks,
      minChunkSize: timeChunks,
      maxChunkSize: timeChunks,
      priority: priorityMap[body.priority],
    };

    if (body.notes) {
      reclaimRequest.notes = body.notes;
    }

    if (body.due) {
      reclaimRequest.due = body.due;
    }

    if (body.private !== undefined) {
      reclaimRequest.alwaysPrivate = body.private;
    }

    // Get Reclaim API key
    const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

    // Call Reclaim API
    const reclaimResponse = await fetch('https://api.app.reclaim.ai/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${reclaimApiKey}`,
      },
      body: JSON.stringify(reclaimRequest),
    });

    if (!reclaimResponse.ok) {
      const errorText = await reclaimResponse.text();
      console.error(`Reclaim API error: ${reclaimResponse.status} - ${errorText}`);

      if (reclaimResponse.status === 429) {
        const retryAfter = reclaimResponse.headers.get('Retry-After') || '60';
        return errorResponse(429, 'rate_limited', `Rate limited, retry after ${retryAfter}s`);
      }

      return errorResponse(502, 'upstream_error', `Reclaim API error: ${reclaimResponse.status}`);
    }

    const reclaimTask = await reclaimResponse.json() as {
      id: string;
      title: string;
      status: string;
      created?: string;
    };

    console.log(`Task created: ${reclaimTask.id} - "${body.title}"`);

    // Return success response
    return jsonResponse(200, {
      success: true,
      task: {
        id: reclaimTask.id,
        title: reclaimTask.title,
        status: reclaimTask.status,
        created: reclaimTask.created || new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Task creation error:', error);
    return errorResponse(500, 'server_error', 'Internal server error');
  }
};
