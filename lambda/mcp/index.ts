import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getSecret,
  getTokenByAccessToken,
} from '../shared/utils';

// MCP Tool Definition
const TOOLS = [
  {
    name: 'create_reclaim_task',
    description: 'Create a new task in Reclaim.ai that will be automatically scheduled on your calendar',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Task title',
        },
        duration_minutes: {
          type: 'integer',
          description: 'Total time needed in minutes (must be divisible by 15)',
        },
        priority: {
          type: 'string',
          enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          description: 'Task priority level (default: LOW)',
        },
        category: {
          type: 'string',
          enum: ['WORK', 'PERSONAL'],
          description: 'Task category',
        },
        notes: {
          type: 'string',
          description: 'Task description/notes (optional)',
        },
        due: {
          type: 'string',
          description: 'Due date in ISO 8601 format (optional)',
        },
        schedule_after: {
          type: 'string',
          description: 'Don\'t schedule this task before this date/time - ISO 8601 format (optional)',
        },
      },
      required: ['title', 'duration_minutes', 'category'],
    },
  },
];

// Server info
const SERVER_INFO = {
  name: 'reclaim-connector',
  version: '1.0.0',
};

const SERVER_CAPABILITIES = {
  tools: {},
};

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // Handle CORS preflight
  if (event.requestContext.http.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: '',
    };
  }

  try {
    // Validate Bearer token
    const authHeader = event.headers?.authorization || event.headers?.Authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return jsonRpcError(null, -32001, 'Unauthorized: Bearer token required');
    }

    const accessToken = authHeader.substring(7);
    const tokenData = await getTokenByAccessToken(accessToken);

    if (!tokenData) {
      return jsonRpcError(null, -32001, 'Unauthorized: Invalid access token');
    }

    const now = Math.floor(Date.now() / 1000);
    if (tokenData.expires_at < now) {
      return jsonRpcError(null, -32001, 'Unauthorized: Access token expired');
    }

    // Parse JSON-RPC request
    let request: JsonRpcRequest;
    try {
      const body = event.isBase64Encoded
        ? Buffer.from(event.body || '', 'base64').toString('utf-8')
        : event.body || '{}';
      request = JSON.parse(body);
    } catch {
      return jsonRpcError(null, -32700, 'Parse error: Invalid JSON');
    }

    if (request.jsonrpc !== '2.0') {
      return jsonRpcError(request.id, -32600, 'Invalid Request: Must be JSON-RPC 2.0');
    }

    // Route to method handler
    switch (request.method) {
      case 'initialize':
        return handleInitialize(request);
      case 'tools/list':
        return handleToolsList(request);
      case 'tools/call':
        return handleToolsCall(request);
      case 'ping':
        return jsonRpcSuccess(request.id, {});
      default:
        return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    console.error('MCP error:', error);
    return jsonRpcError(null, -32603, 'Internal error');
  }
};

function handleInitialize(request: JsonRpcRequest): APIGatewayProxyResultV2 {
  return jsonRpcSuccess(request.id, {
    protocolVersion: '2024-11-05',
    serverInfo: SERVER_INFO,
    capabilities: SERVER_CAPABILITIES,
  });
}

function handleToolsList(request: JsonRpcRequest): APIGatewayProxyResultV2 {
  return jsonRpcSuccess(request.id, {
    tools: TOOLS,
  });
}

async function handleToolsCall(request: JsonRpcRequest): Promise<APIGatewayProxyResultV2> {
  const params = request.params as { name: string; arguments: Record<string, unknown> } | undefined;

  if (!params?.name) {
    return jsonRpcError(request.id, -32602, 'Invalid params: tool name required');
  }

  if (params.name === 'create_reclaim_task') {
    return createReclaimTask(request.id, params.arguments);
  }

  return jsonRpcError(request.id, -32602, `Unknown tool: ${params.name}`);
}

async function createReclaimTask(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
  // Validate required fields
  const { title, duration_minutes, priority, category, notes, due, schedule_after } = args as {
    title?: string;
    duration_minutes?: number;
    priority?: string;
    category?: string;
    notes?: string;
    due?: string;
    schedule_after?: string;
  };

  if (!title || typeof title !== 'string') {
    return jsonRpcError(requestId, -32602, 'Invalid params: title is required');
  }

  if (typeof duration_minutes !== 'number' || duration_minutes <= 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: duration_minutes must be a positive number');
  }

  if (duration_minutes % 15 !== 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: duration_minutes must be divisible by 15');
  }

  const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  const taskPriority = priority || 'LOW'; // Default to LOW
  if (!validPriorities.includes(taskPriority)) {
    return jsonRpcError(requestId, -32602, `Invalid params: priority must be one of ${validPriorities.join(', ')}`);
  }

  const validCategories = ['WORK', 'PERSONAL'];
  if (!category || !validCategories.includes(category)) {
    return jsonRpcError(requestId, -32602, `Invalid params: category must be one of ${validCategories.join(', ')}`);
  }

  // Map priority to Reclaim API values
  const priorityMap: Record<string, string> = {
    'CRITICAL': 'P1',
    'HIGH': 'P2',
    'MEDIUM': 'P3',
    'LOW': 'P4',
  };

  // Build Reclaim API request
  const timeChunks = duration_minutes / 15;
  const reclaimRequest: Record<string, unknown> = {
    title: title.trim(),
    eventCategory: category,
    timeChunksRequired: timeChunks,
    minChunkSize: timeChunks,
    maxChunkSize: timeChunks,
    priority: priorityMap[taskPriority],
    alwaysPrivate: true, // Default to private
  };

  if (notes) {
    reclaimRequest.notes = notes;
  }

  if (due) {
    reclaimRequest.due = due;
  }

  if (schedule_after) {
    reclaimRequest.snoozeUntil = schedule_after;
  }

  // Get Reclaim API key and call API
  const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

  const response = await fetch('https://api.app.reclaim.ai/api/tasks', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${reclaimApiKey}`,
    },
    body: JSON.stringify(reclaimRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Reclaim API error: ${response.status} - ${errorText}`);
    return jsonRpcError(requestId, -32603, `Reclaim API error: ${response.status}`);
  }

  const task = await response.json() as { id: number; title: string; status: string };

  console.log(`Task created: ${task.id} - "${title}"`);

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: `Task created successfully!\n\nID: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}`,
      },
    ],
  });
}

function jsonRpcSuccess(id: string | number | null, result: unknown): APIGatewayProxyResultV2 {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    result,
  };
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): APIGatewayProxyResultV2 {
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id,
    error: { code, message, data },
  };
  return {
    statusCode: 200, // JSON-RPC errors still return 200
    headers: corsHeaders(),
    body: JSON.stringify(response),
  };
}

function corsHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}
