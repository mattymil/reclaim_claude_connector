import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2_integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

export class ReclaimClaudeConnectorStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const tokensTable = new dynamodb.Table(this, 'OAuthTokensTable', {
      tableName: 'reclaim-connector-oauth-tokens',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // TTL disabled via CLI - will be re-enabled on refresh_expires_at after cooldown period
      // timeToLiveAttribute: 'refresh_expires_at',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateTable = new dynamodb.Table(this, 'OAuthStateTable', {
      tableName: 'reclaim-connector-oauth-state',
      partitionKey: { name: 'state', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expires_at',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // GTD Inbox table for quick task capture
    const inboxTable = new dynamodb.Table(this, 'InboxTable', {
      tableName: 'reclaim-connector-inbox',
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Secrets Manager - placeholder secrets (values to be set manually)
    const reclaimApiKeySecret = new secretsmanager.Secret(this, 'ReclaimApiKeySecret', {
      secretName: 'reclaim-api-key',
      description: 'Reclaim.ai API key for Claude MCP connector',
      secretStringValue: cdk.SecretValue.unsafePlainText('REPLACE_WITH_ACTUAL_API_KEY'),
    });

    const oauthConfigSecret = new secretsmanager.Secret(this, 'OAuthConfigSecret', {
      secretName: 'reclaim-connector-oauth-config',
      description: 'OAuth client configuration for Claude MCP connector',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          claude_client_id: 'reclaim-mcp-connector',
          allowed_redirect_uris: [
            'https://claude.ai/oauth/callback',
            'https://api.anthropic.com/oauth/callback',
          ],
          scopes: ['tasks:write'],
          token_expiry_seconds: 3600,
          refresh_token_expiry_seconds: 2592000,
        }),
        generateStringKey: 'claude_client_secret',
      },
    });

    // Lambda Functions
    const authorizeLambda = new NodejsFunction(this, 'AuthorizeLambda', {
      functionName: 'reclaim-connector-oauth-authorize',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/authorize/index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OAUTH_SECRET_NAME: oauthConfigSecret.secretName,
        STATE_TABLE_NAME: stateTable.tableName,
      },
    });

    const tokenLambda = new NodejsFunction(this, 'TokenLambda', {
      functionName: 'reclaim-connector-oauth-token',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/token/index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(10),
      environment: {
        OAUTH_SECRET_NAME: oauthConfigSecret.secretName,
        TOKENS_TABLE_NAME: tokensTable.tableName,
        STATE_TABLE_NAME: stateTable.tableName,
      },
    });

    const taskLambda = new NodejsFunction(this, 'TaskLambda', {
      functionName: 'reclaim-connector-task',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/task/index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        RECLAIM_SECRET_NAME: reclaimApiKeySecret.secretName,
        TOKENS_TABLE_NAME: tokensTable.tableName,
      },
    });

    const mcpLambda = new NodejsFunction(this, 'McpLambda', {
      functionName: 'reclaim-connector-mcp',
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: path.join(__dirname, '../lambda/mcp/index.ts'),
      handler: 'handler',
      memorySize: 256,
      timeout: cdk.Duration.seconds(30),
      environment: {
        RECLAIM_SECRET_NAME: reclaimApiKeySecret.secretName,
        TOKENS_TABLE_NAME: tokensTable.tableName,
        INBOX_TABLE_NAME: inboxTable.tableName,
      },
    });

    // Grant permissions
    tokensTable.grantReadWriteData(tokenLambda);
    tokensTable.grantReadWriteData(authorizeLambda);
    stateTable.grantReadWriteData(authorizeLambda);
    stateTable.grantReadWriteData(tokenLambda);
    tokensTable.grantReadData(taskLambda);

    reclaimApiKeySecret.grantRead(taskLambda);
    reclaimApiKeySecret.grantRead(mcpLambda);
    tokensTable.grantReadData(mcpLambda);
    inboxTable.grantReadWriteData(mcpLambda);
    oauthConfigSecret.grantRead(authorizeLambda);
    oauthConfigSecret.grantRead(tokenLambda);

    // API Gateway HTTP API
    const httpApi = new apigatewayv2.HttpApi(this, 'ReclaimMcpApi', {
      apiName: 'reclaim-mcp-api',
      corsPreflight: {
        allowOrigins: ['https://claude.ai', 'https://api.anthropic.com'],
        allowMethods: [apigatewayv2.CorsHttpMethod.GET, apigatewayv2.CorsHttpMethod.POST],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    // Routes
    httpApi.addRoutes({
      path: '/oauth/authorize',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('AuthorizeIntegration', authorizeLambda),
    });

    // Claude expects /authorize at root
    httpApi.addRoutes({
      path: '/authorize',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('AuthorizeRootIntegration', authorizeLambda),
    });

    httpApi.addRoutes({
      path: '/oauth/token',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('TokenIntegration', tokenLambda),
    });

    // Claude expects /token at root
    httpApi.addRoutes({
      path: '/token',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('TokenRootIntegration', tokenLambda),
    });

    httpApi.addRoutes({
      path: '/oauth/revoke',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('RevokeIntegration', tokenLambda),
    });

    httpApi.addRoutes({
      path: '/mcp/reclaim/task',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('TaskIntegration', taskLambda),
    });

    httpApi.addRoutes({
      path: '/mcp',
      methods: [apigatewayv2.HttpMethod.POST, apigatewayv2.HttpMethod.OPTIONS],
      integration: new apigatewayv2_integrations.HttpLambdaIntegration('McpIntegration', mcpLambda),
    });

    // Outputs
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: httpApi.apiEndpoint,
      description: 'API Gateway endpoint URL',
    });

    new cdk.CfnOutput(this, 'AuthorizationUrl', {
      value: `${httpApi.apiEndpoint}/oauth/authorize`,
      description: 'OAuth authorization URL',
    });

    new cdk.CfnOutput(this, 'TokenUrl', {
      value: `${httpApi.apiEndpoint}/oauth/token`,
      description: 'OAuth token URL',
    });

    new cdk.CfnOutput(this, 'TaskUrl', {
      value: `${httpApi.apiEndpoint}/mcp/reclaim/task`,
      description: 'Task creation endpoint URL',
    });

    new cdk.CfnOutput(this, 'McpServerUrl', {
      value: `${httpApi.apiEndpoint}/mcp`,
      description: 'MCP server URL for Claude connector',
    });
  }
}
