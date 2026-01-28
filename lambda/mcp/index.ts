import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getSecret,
  getTokenByAccessToken,
} from '../shared/utils';

// MCP Tool Definitions
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
          description: 'Total time needed in minutes, must be divisible by 15 (default: 30)',
        },
        priority: {
          type: 'string',
          enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          description: 'Task priority level (default: LOW)',
        },
        category: {
          type: 'string',
          enum: ['WORK', 'PERSONAL'],
          description: 'Task category (default: WORK)',
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
      required: ['title'],
    },
  },
  {
    name: 'update_reclaim_task',
    description: 'Update an existing task in Reclaim.ai',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: {
          type: 'integer',
          description: 'The ID of the task to update',
        },
        title: {
          type: 'string',
          description: 'New task title (optional)',
        },
        duration_minutes: {
          type: 'integer',
          description: 'New duration in minutes, must be divisible by 15 (optional)',
        },
        priority: {
          type: 'string',
          enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
          description: 'New priority level (optional)',
        },
        notes: {
          type: 'string',
          description: 'New task notes (optional)',
        },
        due: {
          type: 'string',
          description: 'New due date in ISO 8601 format (optional)',
        },
        schedule_after: {
          type: 'string',
          description: 'Don\'t schedule before this date/time - ISO 8601 format (optional)',
        },
        status: {
          type: 'string',
          enum: ['NEW', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'],
          description: 'New task status (optional)',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_reclaim_tasks',
    description: 'List tasks from Reclaim.ai, optionally filtered by date range',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start of date range in ISO 8601 format (optional, defaults to today)',
        },
        end_date: {
          type: 'string',
          description: 'End of date range in ISO 8601 format (optional, defaults to 7 days from start)',
        },
        status: {
          type: 'string',
          enum: ['NEW', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'],
          description: 'Filter by task status (optional)',
        },
      },
      required: [],
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

// Priority mapping
const PRIORITY_MAP: Record<string, string> = {
  'CRITICAL': 'P1',
  'HIGH': 'P2',
  'MEDIUM': 'P3',
  'LOW': 'P4',
};

const PRIORITY_REVERSE_MAP: Record<string, string> = {
  'P1': 'CRITICAL',
  'P2': 'HIGH',
  'P3': 'MEDIUM',
  'P4': 'LOW',
};

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

  switch (params.name) {
    case 'create_reclaim_task':
      return createReclaimTask(request.id, params.arguments || {});
    case 'update_reclaim_task':
      return updateReclaimTask(request.id, params.arguments || {});
    case 'list_reclaim_tasks':
      return listReclaimTasks(request.id, params.arguments || {});
    default:
      return jsonRpcError(request.id, -32602, `Unknown tool: ${params.name}`);
  }
}

async function createReclaimTask(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
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

  // Default duration to 30 minutes
  const taskDuration = duration_minutes ?? 30;
  if (typeof taskDuration !== 'number' || taskDuration <= 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: duration_minutes must be a positive number');
  }
  if (taskDuration % 15 !== 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: duration_minutes must be divisible by 15');
  }

  // Default priority to LOW
  const taskPriority = priority || 'LOW';
  const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
  if (!validPriorities.includes(taskPriority)) {
    return jsonRpcError(requestId, -32602, `Invalid params: priority must be one of ${validPriorities.join(', ')}`);
  }

  // Default category to WORK
  const taskCategory = category || 'WORK';
  const validCategories = ['WORK', 'PERSONAL'];
  if (!validCategories.includes(taskCategory)) {
    return jsonRpcError(requestId, -32602, `Invalid params: category must be one of ${validCategories.join(', ')}`);
  }

  // Build Reclaim API request
  const timeChunks = taskDuration / 15;
  const reclaimRequest: Record<string, unknown> = {
    title: title.trim(),
    eventCategory: taskCategory,
    timeChunksRequired: timeChunks,
    minChunkSize: timeChunks,
    maxChunkSize: timeChunks,
    priority: PRIORITY_MAP[taskPriority],
    alwaysPrivate: true,
  };

  if (notes) reclaimRequest.notes = notes;
  if (due) reclaimRequest.due = due;
  if (schedule_after) reclaimRequest.snoozeUntil = schedule_after;

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

async function updateReclaimTask(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
  const { task_id, title, duration_minutes, priority, notes, due, schedule_after, status } = args as {
    task_id?: number;
    title?: string;
    duration_minutes?: number;
    priority?: string;
    notes?: string;
    due?: string;
    schedule_after?: string;
    status?: string;
  };

  if (!task_id || typeof task_id !== 'number') {
    return jsonRpcError(requestId, -32602, 'Invalid params: task_id is required');
  }

  // Build update request with only provided fields
  const updateRequest: Record<string, unknown> = {};

  if (title) updateRequest.title = title.trim();
  if (notes !== undefined) updateRequest.notes = notes;
  if (due) updateRequest.due = due;
  if (schedule_after) updateRequest.snoozeUntil = schedule_after;
  if (status) updateRequest.status = status;

  if (duration_minutes !== undefined) {
    if (duration_minutes % 15 !== 0) {
      return jsonRpcError(requestId, -32602, 'Invalid params: duration_minutes must be divisible by 15');
    }
    const timeChunks = duration_minutes / 15;
    updateRequest.timeChunksRequired = timeChunks;
    updateRequest.minChunkSize = timeChunks;
    updateRequest.maxChunkSize = timeChunks;
  }

  if (priority) {
    const validPriorities = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
    if (!validPriorities.includes(priority)) {
      return jsonRpcError(requestId, -32602, `Invalid params: priority must be one of ${validPriorities.join(', ')}`);
    }
    updateRequest.priority = PRIORITY_MAP[priority];
  }

  const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

  const response = await fetch(`https://api.app.reclaim.ai/api/tasks/${task_id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${reclaimApiKey}`,
    },
    body: JSON.stringify(updateRequest),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Reclaim API error: ${response.status} - ${errorText}`);
    return jsonRpcError(requestId, -32603, `Reclaim API error: ${response.status}`);
  }

  const task = await response.json() as { id: number; title: string; status: string };
  console.log(`Task updated: ${task.id}`);

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: `Task updated successfully!\n\nID: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}`,
      },
    ],
  });
}

async function listReclaimTasks(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
  const { start_date, end_date, status } = args as {
    start_date?: string;
    end_date?: string;
    status?: string;
  };

  const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

  // Build query params
  const params = new URLSearchParams();
  if (start_date) params.append('start', start_date);
  if (end_date) params.append('end', end_date);
  if (status) params.append('status', status);

  const url = `https://api.app.reclaim.ai/api/tasks${params.toString() ? '?' + params.toString() : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${reclaimApiKey}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Reclaim API error: ${response.status} - ${errorText}`);
    return jsonRpcError(requestId, -32603, `Reclaim API error: ${response.status}`);
  }

  const tasks = await response.json() as Array<{
    id: number;
    title: string;
    status: string;
    priority: string;
    eventCategory: string;
    timeChunksRequired: number;
    due?: string;
    snoozeUntil?: string;
  }>;

  // Format tasks for display
  const taskList = tasks.map(t => {
    const priority = PRIORITY_REVERSE_MAP[t.priority] || t.priority;
    const duration = t.timeChunksRequired * 15;
    let line = `• [${t.id}] ${t.title} (${duration}min, ${priority}, ${t.status})`;
    if (t.due) line += ` - Due: ${t.due}`;
    return line;
  }).join('\n');

  const summary = tasks.length === 0
    ? 'No tasks found.'
    : `Found ${tasks.length} task(s):\n\n${taskList}`;

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: summary,
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
    statusCode: 200,
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
