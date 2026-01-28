import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  // TODO: Implement task creation
  // 1. Extract and validate Bearer token
  // 2. Validate token against DynamoDB (hash, expiry, scope)
  // 3. Parse and validate request body (title, duration_minutes, priority, category)
  // 4. Transform parameters to Reclaim API format
  // 5. POST to Reclaim.ai API
  // 6. Return MCP response

  return {
    statusCode: 501,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'not_implemented', message: 'Task endpoint not yet implemented' }),
  };
};
