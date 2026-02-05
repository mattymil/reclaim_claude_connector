import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  getSecret,
  getTokenByAccessToken,
  saveInboxItem,
  getInboxItems,
  getNextInboxItem,
  markInboxItemProcessed,
  InboxItem,
  getProcessedOtterMeetings,
  markOtterMeetingProcessed,
  ProcessedMeeting,
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
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
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
          enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
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
  {
    name: 'search_reclaim_tasks',
    description: 'Search for tasks in Reclaim.ai with flexible filtering by title, status, priority, category, and more',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search text to match against task titles (case-insensitive)',
        },
        status: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['NEW', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETE', 'CANCELLED'],
          },
          description: 'Filter by one or more task statuses',
        },
        priority: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
          },
          description: 'Filter by one or more priority levels',
        },
        category: {
          type: 'string',
          enum: ['WORK', 'PERSONAL'],
          description: 'Filter by task category',
        },
        has_due_date: {
          type: 'boolean',
          description: 'Filter to tasks that have (true) or do not have (false) a due date',
        },
        due_before: {
          type: 'string',
          description: 'Filter to tasks due before this date (ISO 8601 format)',
        },
        due_after: {
          type: 'string',
          description: 'Filter to tasks due after this date (ISO 8601 format)',
        },
        include_completed: {
          type: 'boolean',
          description: 'Include completed and cancelled tasks in results (default: false)',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of results to return (default: 50)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_scheduled_tasks',
    description: 'Get tasks that are scheduled on the calendar within a date range, showing their actual scheduled times (not just due dates)',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: {
          type: 'string',
          description: 'Start of date range in ISO 8601 format (default: today)',
        },
        end_date: {
          type: 'string',
          description: 'End of date range in ISO 8601 format (default: 7 days from start)',
        },
      },
      required: [],
    },
  },
  // GTD Inbox tools
  {
    name: 'add_to_inbox',
    description: 'Quick capture a task idea to the GTD inbox for later processing. Use this for rapid capture without needing to specify task details like duration or priority.',
    inputSchema: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'Brief description of the task or idea',
        },
        notes: {
          type: 'string',
          description: 'Additional context or details (optional)',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_inbox',
    description: 'List all items in the GTD inbox that have not been processed yet',
    inputSchema: {
      type: 'object',
      properties: {
        include_processed: {
          type: 'boolean',
          description: 'Include already processed items (default: false)',
        },
      },
      required: [],
    },
  },
  {
    name: 'get_next_inbox_item',
    description: 'Get the next (oldest) unprocessed item from the GTD inbox for processing into a Reclaim task',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'mark_inbox_processed',
    description: 'Mark an inbox item as processed after it has been converted to a Reclaim task',
    inputSchema: {
      type: 'object',
      properties: {
        item_id: {
          type: 'string',
          description: 'The ID of the inbox item to mark as processed (the sk value)',
        },
      },
      required: ['item_id'],
    },
  },
  // Otter processed meetings tracking tools
  {
    name: 'get_processed_otter_meetings',
    description: 'Get a list of Otter meetings that have already had their action items exported to Reclaim. Use this to avoid duplicate exports.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'mark_otter_meeting_processed',
    description: 'Mark an Otter meeting as processed after exporting its action items to Reclaim. This prevents duplicate exports in future sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        otter_meeting_id: {
          type: 'string',
          description: 'The unique ID of the Otter meeting',
        },
        meeting_title: {
          type: 'string',
          description: 'The title of the meeting (optional, for reference)',
        },
        action_items_count: {
          type: 'integer',
          description: 'Number of action items exported (optional, for reference)',
        },
      },
      required: ['otter_meeting_id'],
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

// Get Eastern Time offset for a given date (handles DST)
function getEasternOffset(date: Date): string {
  // Format a date in Eastern time and extract the offset
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const parts = formatter.formatToParts(date);
  const offsetPart = parts.find(p => p.type === 'timeZoneName');
  // Returns something like "GMT-5" or "GMT-4"
  if (offsetPart) {
    const match = offsetPart.value.match(/GMT([+-]\d+)/);
    if (match) {
      const hours = parseInt(match[1], 10);
      const sign = hours >= 0 ? '+' : '-';
      return `${sign}${String(Math.abs(hours)).padStart(2, '0')}:00`;
    }
  }
  // Fallback to EST
  return '-05:00';
}

// Convert date to full ISO 8601 datetime with timezone for Reclaim API
function toReclaimDateTime(dateStr: string, endOfDay: boolean = true): string {
  // If already has time component with timezone, return as-is
  if (dateStr.includes('T') && (dateStr.includes('Z') || dateStr.includes('+') || dateStr.includes('-', 10))) {
    return dateStr;
  }

  // Parse the date to determine correct Eastern offset (EST vs EDT)
  const targetDate = new Date(dateStr);
  const offset = getEasternOffset(targetDate);

  // If has time but no timezone, add Eastern timezone
  if (dateStr.includes('T')) {
    return `${dateStr}${offset}`;
  }

  // Date only (YYYY-MM-DD) - convert to end of day or start of day in Eastern
  const time = endOfDay ? 'T23:59:59' : 'T00:00:00';
  return `${dateStr}${time}${offset}`;
}

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
        return handleToolsCall(request, tokenData.pk);
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

async function handleToolsCall(request: JsonRpcRequest, userPk: string): Promise<APIGatewayProxyResultV2> {
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
    case 'search_reclaim_tasks':
      return searchReclaimTasks(request.id, params.arguments || {});
    case 'get_scheduled_tasks':
      return getScheduledTasks(request.id, params.arguments || {});
    case 'add_to_inbox':
      return addToInbox(request.id, params.arguments || {}, userPk);
    case 'list_inbox':
      return listInbox(request.id, params.arguments || {}, userPk);
    case 'get_next_inbox_item':
      return getNextInboxItemHandler(request.id, userPk);
    case 'mark_inbox_processed':
      return markInboxProcessedHandler(request.id, params.arguments || {}, userPk);
    case 'get_processed_otter_meetings':
      return getProcessedOtterMeetingsHandler(request.id, userPk);
    case 'mark_otter_meeting_processed':
      return markOtterMeetingProcessedHandler(request.id, params.arguments || {}, userPk);
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
  if (due) reclaimRequest.due = toReclaimDateTime(due, true);
  if (schedule_after) reclaimRequest.snoozeUntil = toReclaimDateTime(schedule_after, false);

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

  const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

  // Handle status changes via dedicated endpoints
  // Reclaim uses special endpoints for marking tasks complete/incomplete
  if (status) {
    let statusEndpoint: string | null = null;
    let statusAction: string = '';

    switch (status) {
      case 'COMPLETE':
        statusEndpoint = `https://api.app.reclaim.ai/api/planner/done/task/${task_id}`;
        statusAction = 'marked complete';
        break;
      case 'NEW':
      case 'SCHEDULED':
        // Unarchive returns task to active state
        statusEndpoint = `https://api.app.reclaim.ai/api/planner/unarchive/task/${task_id}`;
        statusAction = 'restored to active';
        break;
      case 'CANCELLED':
        // Try the delete/cancel endpoint
        statusEndpoint = `https://api.app.reclaim.ai/api/tasks/${task_id}`;
        statusAction = 'cancelled';
        break;
    }

    if (statusEndpoint && status !== 'CANCELLED') {
      const statusResponse = await fetch(statusEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${reclaimApiKey}`,
        },
      });

      if (!statusResponse.ok) {
        const errorText = await statusResponse.text();
        console.error(`Reclaim status API error: ${statusResponse.status} - ${errorText}`);
        return jsonRpcError(requestId, -32603, `Reclaim API error changing status: ${statusResponse.status}`);
      }

      // If only status was being changed, return success
      const hasOtherUpdates = title || notes !== undefined || due || schedule_after || duration_minutes !== undefined || priority;
      if (!hasOtherUpdates) {
        const task = await statusResponse.json() as { id: number; title: string; status: string };
        console.log(`Task ${task.id} ${statusAction}`);
        return jsonRpcSuccess(requestId, {
          content: [
            {
              type: 'text',
              text: `Task ${statusAction} successfully!\n\nID: ${task.id}\nTitle: ${task.title}\nStatus: ${task.status}`,
            },
          ],
        });
      }
    }
  }

  // Build update request with only provided fields (excluding status which is handled above)
  const updateRequest: Record<string, unknown> = {};

  if (title) updateRequest.title = title.trim();
  if (notes !== undefined) updateRequest.notes = notes;
  if (due) updateRequest.due = toReclaimDateTime(due, true);
  if (schedule_after) updateRequest.snoozeUntil = toReclaimDateTime(schedule_after, false);

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

  // Only make PATCH request if there are fields to update
  if (Object.keys(updateRequest).length === 0) {
    return jsonRpcError(requestId, -32602, 'Invalid params: no fields to update');
  }

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

interface ReclaimTask {
  id: number;
  title: string;
  status: string;
  priority: string;
  eventCategory: string;
  timeChunksRequired: number;
  timeChunksSpent?: number;
  due?: string;
  snoozeUntil?: string;
  notes?: string;
  created?: string;
  updated?: string;
}

async function searchReclaimTasks(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
  const {
    query,
    status,
    priority,
    category,
    has_due_date,
    due_before,
    due_after,
    include_completed,
    limit,
  } = args as {
    query?: string;
    status?: string[];
    priority?: string[];
    category?: string;
    has_due_date?: boolean;
    due_before?: string;
    due_after?: string;
    include_completed?: boolean;
    limit?: number;
  };

  const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

  // Fetch all tasks from the API
  const response = await fetch('https://api.app.reclaim.ai/api/tasks', {
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

  let tasks = await response.json() as ReclaimTask[];

  // Apply filters client-side for flexibility

  // Filter by title query (case-insensitive)
  if (query) {
    const lowerQuery = query.toLowerCase();
    tasks = tasks.filter(t => t.title.toLowerCase().includes(lowerQuery));
  }

  // Filter by status
  if (status && status.length > 0) {
    tasks = tasks.filter(t => status.includes(t.status));
  } else if (!include_completed) {
    // By default, exclude completed and cancelled tasks
    tasks = tasks.filter(t => !['COMPLETE', 'CANCELLED'].includes(t.status));
  }

  // Filter by priority (convert to P1-P4 format)
  if (priority && priority.length > 0) {
    const apiPriorities = priority.map(p => PRIORITY_MAP[p]).filter(Boolean);
    tasks = tasks.filter(t => apiPriorities.includes(t.priority));
  }

  // Filter by category
  if (category) {
    tasks = tasks.filter(t => t.eventCategory === category);
  }

  // Filter by due date existence
  if (has_due_date !== undefined) {
    tasks = tasks.filter(t => has_due_date ? !!t.due : !t.due);
  }

  // Filter by due date range
  if (due_before) {
    const dueBefore = new Date(due_before).getTime();
    tasks = tasks.filter(t => {
      if (!t.due) return false;
      return new Date(t.due).getTime() < dueBefore;
    });
  }

  if (due_after) {
    const dueAfter = new Date(due_after).getTime();
    tasks = tasks.filter(t => {
      if (!t.due) return false;
      return new Date(t.due).getTime() > dueAfter;
    });
  }

  // Apply limit
  const maxResults = limit && limit > 0 ? Math.min(limit, 100) : 50;
  tasks = tasks.slice(0, maxResults);

  // Format tasks for display with more detail
  const taskList = tasks.map(t => {
    const priorityLabel = PRIORITY_REVERSE_MAP[t.priority] || t.priority;
    const duration = t.timeChunksRequired * 15;
    const spent = t.timeChunksSpent ? t.timeChunksSpent * 15 : 0;

    let line = `• [${t.id}] ${t.title}`;
    line += `\n  Status: ${t.status} | Priority: ${priorityLabel} | Category: ${t.eventCategory}`;
    line += `\n  Duration: ${duration}min${spent > 0 ? ` (${spent}min spent)` : ''}`;
    if (t.due) {
      const dueDate = new Date(t.due);
      line += `\n  Due: ${dueDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' })} ${dueDate.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })}`;
    }
    if (t.snoozeUntil) {
      const snoozeDate = new Date(t.snoozeUntil);
      line += `\n  Schedule after: ${snoozeDate.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}`;
    }
    if (t.notes) {
      const truncatedNotes = t.notes.length > 100 ? t.notes.substring(0, 100) + '...' : t.notes;
      line += `\n  Notes: ${truncatedNotes}`;
    }
    return line;
  }).join('\n\n');

  // Build filter summary
  const filters: string[] = [];
  if (query) filters.push(`title contains "${query}"`);
  if (status && status.length > 0) filters.push(`status: ${status.join(', ')}`);
  if (priority && priority.length > 0) filters.push(`priority: ${priority.join(', ')}`);
  if (category) filters.push(`category: ${category}`);
  if (has_due_date !== undefined) filters.push(has_due_date ? 'has due date' : 'no due date');
  if (due_before) filters.push(`due before ${due_before}`);
  if (due_after) filters.push(`due after ${due_after}`);

  const filterSummary = filters.length > 0 ? `Filters: ${filters.join(', ')}\n\n` : '';

  const summary = tasks.length === 0
    ? `${filterSummary}No tasks found matching your criteria.`
    : `${filterSummary}Found ${tasks.length} task(s):\n\n${taskList}`;

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: summary,
      },
    ],
  });
}

interface CalendarEvent {
  eventId: string;
  title: string;
  eventStart: string;
  eventEnd: string;
  priority: string;
  type: string;
  reclaimEventType: string;
  assist?: {
    type: string;
    taskId: number;
    task?: boolean;
  };
}

async function getScheduledTasks(
  requestId: string | number,
  args: Record<string, unknown>
): Promise<APIGatewayProxyResultV2> {
  console.log('getScheduledTasks called with args:', JSON.stringify(args));

  try {
    const { start_date, end_date } = args as {
      start_date?: string;
      end_date?: string;
    };

    const reclaimApiKey = await getSecret(process.env.RECLAIM_SECRET_NAME!);

    // Default to today if no start date
    const startDate = start_date || new Date().toISOString().split('T')[0];

    // Default to 7 days from start if no end date
    let endDate = end_date;
    if (!endDate) {
      const end = new Date(startDate);
      end.setDate(end.getDate() + 7);
      endDate = end.toISOString().split('T')[0];
    }

    // If start and end are the same day, adjust end to next day to cover full day
    if (endDate === startDate) {
      const end = new Date(startDate);
      end.setDate(end.getDate() + 1);
      endDate = end.toISOString().split('T')[0];
    }

    // Query the events endpoint to get scheduled task events
    const params = new URLSearchParams();
    params.append('start', startDate);
    params.append('end', endDate);

    const url = `https://api.app.reclaim.ai/api/events?${params.toString()}`;
    console.log('Fetching events from:', url);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${reclaimApiKey}`,
      },
    });

    console.log('Events API response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`Reclaim events API error: ${response.status} - ${errorText}`);
      return jsonRpcError(requestId, -32603, `Reclaim API error: ${response.status}`);
    }

    const eventsData = await response.json();
    console.log('Events response type:', typeof eventsData, Array.isArray(eventsData) ? `array of ${eventsData.length}` : 'not array');

    // Log first event structure if available
    if (Array.isArray(eventsData) && eventsData.length > 0) {
      console.log('First event keys:', Object.keys(eventsData[0]));
    }

    const events = eventsData as CalendarEvent[];

    // Filter to only task events (reclaimEventType === "TASK_ASSIGNMENT")
    const taskEvents = events.filter(e => e.reclaimEventType === 'TASK_ASSIGNMENT' && e.assist?.taskId);

    console.log(`Found ${taskEvents.length} task events out of ${events.length} total events`);

    // Group events by task ID to show all scheduled times per task
    const taskMap = new Map<number, {
      taskId: number;
      title: string;
      priority: string;
      type: string;
      events: Array<{ start: string; end: string }>
    }>();

    for (const event of taskEvents) {
      if (!event.assist?.taskId) continue;

      const taskId = event.assist.taskId;
      if (!taskMap.has(taskId)) {
        taskMap.set(taskId, {
          taskId,
          title: event.title,
          priority: event.priority,
          type: event.type,
          events: [],
        });
      }
      taskMap.get(taskId)!.events.push({
        start: event.eventStart,
        end: event.eventEnd,
      });
    }

    // Sort events within each task by start time
    for (const entry of taskMap.values()) {
      entry.events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
    }

    // Format output
    const taskList = Array.from(taskMap.values()).map(({ taskId, title, priority, type, events: taskEventList }) => {
      const priorityLabel = PRIORITY_REVERSE_MAP[priority] || priority;

      let line = `• [${taskId}] ${title}`;
      line += `\n  Priority: ${priorityLabel} | Category: ${type}`;
      line += `\n  Scheduled times:`;

      for (const evt of taskEventList) {
        const startDt = new Date(evt.start);
        const endDt = new Date(evt.end);
        const dateStr = startDt.toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
        const startTime = startDt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
        const endTime = endDt.toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
        line += `\n    - ${dateStr}: ${startTime} - ${endTime}`;
      }

      return line;
    }).join('\n\n');

    const summary = taskMap.size === 0
      ? `No tasks scheduled between ${startDate} and ${endDate}.`
      : `Tasks scheduled between ${startDate} and ${endDate}:\n\n${taskList}`;

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: summary,
      },
    ],
  });
  } catch (error) {
    console.error('getScheduledTasks error:', error);
    return jsonRpcError(requestId, -32603, `Internal error: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// GTD Inbox handlers
async function addToInbox(
  requestId: string | number,
  args: Record<string, unknown>,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const { title, notes } = args as {
    title?: string;
    notes?: string;
  };

  if (!title || typeof title !== 'string') {
    return jsonRpcError(requestId, -32602, 'Invalid params: title is required');
  }

  // Extract userId from pk (format: USER#userId)
  const userId = userPk.replace('USER#', '');

  try {
    const { id } = await saveInboxItem(userId, title.trim(), notes?.trim());
    console.log(`Inbox item added: ${id} - "${title}"`);

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: `Added to inbox!\n\nTitle: ${title}${notes ? `\nNotes: ${notes}` : ''}`,
        },
      ],
    });
  } catch (error) {
    console.error('addToInbox error:', error);
    return jsonRpcError(requestId, -32603, `Failed to add to inbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function listInbox(
  requestId: string | number,
  args: Record<string, unknown>,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const { include_processed } = args as {
    include_processed?: boolean;
  };

  const userId = userPk.replace('USER#', '');

  try {
    const items = await getInboxItems(userId, include_processed || false);

    if (items.length === 0) {
      return jsonRpcSuccess(requestId, {
        content: [
          {
            type: 'text',
            text: 'Your inbox is empty! Use add_to_inbox to capture new tasks.',
          },
        ],
      });
    }

    const itemList = items.map((item, index) => {
      const createdDate = new Date(item.created_at);
      const dateStr = createdDate.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
      let line = `${index + 1}. ${item.title}`;
      if (item.notes) line += `\n   Notes: ${item.notes}`;
      line += `\n   Added: ${dateStr}`;
      if (item.processed) line += ' [PROCESSED]';
      line += `\n   ID: ${item.sk}`;
      return line;
    }).join('\n\n');

    const summary = `Inbox (${items.length} item${items.length !== 1 ? 's' : ''}):\n\n${itemList}`;

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: summary,
        },
      ],
    });
  } catch (error) {
    console.error('listInbox error:', error);
    return jsonRpcError(requestId, -32603, `Failed to list inbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function getNextInboxItemHandler(
  requestId: string | number,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const userId = userPk.replace('USER#', '');

  try {
    const item = await getNextInboxItem(userId);

    if (!item) {
      return jsonRpcSuccess(requestId, {
        content: [
          {
            type: 'text',
            text: 'Your inbox is empty! All items have been processed.',
          },
        ],
      });
    }

    const createdDate = new Date(item.created_at);
    const dateStr = createdDate.toLocaleDateString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });

    let text = `Next inbox item:\n\nTitle: ${item.title}`;
    if (item.notes) text += `\nNotes: ${item.notes}`;
    text += `\nAdded: ${dateStr}`;
    text += `\nID: ${item.sk}`;
    text += `\n\nProvide task details (duration, priority, category, due date) to create in Reclaim, then use mark_inbox_processed with this ID.`;

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    });
  } catch (error) {
    console.error('getNextInboxItem error:', error);
    return jsonRpcError(requestId, -32603, `Failed to get next inbox item: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function markInboxProcessedHandler(
  requestId: string | number,
  args: Record<string, unknown>,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const { item_id } = args as {
    item_id?: string;
  };

  if (!item_id || typeof item_id !== 'string') {
    return jsonRpcError(requestId, -32602, 'Invalid params: item_id is required');
  }

  const userId = userPk.replace('USER#', '');

  try {
    await markInboxItemProcessed(userId, item_id);
    console.log(`Inbox item marked processed: ${item_id}`);

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: `Inbox item marked as processed.\n\nUse get_next_inbox_item to continue processing your inbox.`,
        },
      ],
    });
  } catch (error) {
    console.error('markInboxProcessed error:', error);
    return jsonRpcError(requestId, -32603, `Failed to mark item processed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Otter processed meetings handlers
async function getProcessedOtterMeetingsHandler(
  requestId: string | number,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const userId = userPk.replace('USER#', '');

  try {
    const meetings = await getProcessedOtterMeetings(userId);

    if (meetings.length === 0) {
      return jsonRpcSuccess(requestId, {
        content: [
          {
            type: 'text',
            text: 'No Otter meetings have been processed yet.',
          },
        ],
      });
    }

    const meetingList = meetings.map((m, index) => {
      const processedDate = new Date(m.processed_at);
      const dateStr = processedDate.toLocaleDateString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      let line = `${index + 1}. ${m.meeting_title || '(No title)'}`;
      line += `\n   Meeting ID: ${m.otter_meeting_id}`;
      if (m.action_items_count !== null) {
        line += `\n   Action items exported: ${m.action_items_count}`;
      }
      line += `\n   Processed: ${dateStr}`;
      return line;
    }).join('\n\n');

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: `Processed Otter meetings (${meetings.length}):\n\n${meetingList}`,
        },
      ],
    });
  } catch (error) {
    console.error('getProcessedOtterMeetings error:', error);
    return jsonRpcError(requestId, -32603, `Failed to get processed meetings: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function markOtterMeetingProcessedHandler(
  requestId: string | number,
  args: Record<string, unknown>,
  userPk: string
): Promise<APIGatewayProxyResultV2> {
  const { otter_meeting_id, meeting_title, action_items_count } = args as {
    otter_meeting_id?: string;
    meeting_title?: string;
    action_items_count?: number;
  };

  if (!otter_meeting_id || typeof otter_meeting_id !== 'string') {
    return jsonRpcError(requestId, -32602, 'Invalid params: otter_meeting_id is required');
  }

  const userId = userPk.replace('USER#', '');

  try {
    const { processed_at } = await markOtterMeetingProcessed(
      userId,
      otter_meeting_id,
      meeting_title,
      action_items_count
    );
    console.log(`Otter meeting marked processed: ${otter_meeting_id}`);

    return jsonRpcSuccess(requestId, {
      content: [
        {
          type: 'text',
          text: `Otter meeting marked as processed.\n\nMeeting ID: ${otter_meeting_id}${meeting_title ? `\nTitle: ${meeting_title}` : ''}${action_items_count !== undefined ? `\nAction items: ${action_items_count}` : ''}\nProcessed at: ${processed_at}`,
        },
      ],
    });
  } catch (error) {
    console.error('markOtterMeetingProcessed error:', error);
    return jsonRpcError(requestId, -32603, `Failed to mark meeting processed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
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
