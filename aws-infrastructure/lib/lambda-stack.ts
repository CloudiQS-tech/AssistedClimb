import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface LambdaStackProps extends cdk.StackProps {
  /**
   * VPC for Lambda functions
   */
  vpc: ec2.IVpc;
  
  /**
   * Security group for Lambda functions
   */
  lambdaSecurityGroup: ec2.ISecurityGroup;
  
  /**
   * Lambda execution role ARN
   */
  lambdaExecutionRoleArn: string;
  
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
}

export class LambdaStack extends cdk.Stack {
  public readonly aiOrchestrationFunction: lambda.Function;
  public readonly googleGeminiFunction: lambda.Function;
  public readonly microsoftCopilotFunction: lambda.Function;
  public readonly bedrockFunction: lambda.Function;
  public readonly aiAuditTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    const {
      vpc,
      lambdaSecurityGroup,
      lambdaExecutionRoleArn,
      projectName = 'assisted-climb'
    } = props;

    // Import Lambda execution role
    const executionRole = iam.Role.fromRoleArn(this, 'ImportedLambdaExecutionRole', lambdaExecutionRoleArn);

    // Create DynamoDB table for AI interaction audit logging
    this.aiAuditTable = this.createAiAuditTable(projectName);

    // Create AI provider secrets
    this.createAiProviderSecrets(projectName);

    // Create Lambda functions for AI integration
    this.aiOrchestrationFunction = this.createAiOrchestrationFunction(
      projectName,
      vpc,
      lambdaSecurityGroup,
      executionRole
    );

    this.googleGeminiFunction = this.createGoogleGeminiFunction(
      projectName,
      vpc,
      lambdaSecurityGroup,
      executionRole
    );

    this.microsoftCopilotFunction = this.createMicrosoftCopilotFunction(
      projectName,
      vpc,
      lambdaSecurityGroup,
      executionRole
    );

    this.bedrockFunction = this.createBedrockFunction(
      projectName,
      vpc,
      lambdaSecurityGroup,
      executionRole
    );

    // Create outputs
    this.createOutputs();
  }

  private createAiAuditTable(projectName: string): dynamodb.Table {
    return new dynamodb.Table(this, 'AiAuditTable', {
      tableName: `${projectName}-ai-audit-log`,
      partitionKey: {
        name: 'organizationId',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN, // Retain audit logs
      
      // Global Secondary Index for querying by user
      globalSecondaryIndexes: [
        {
          indexName: 'UserIndex',
          partitionKey: {
            name: 'userId',
            type: dynamodb.AttributeType.STRING
          },
          sortKey: {
            name: 'timestamp',
            type: dynamodb.AttributeType.STRING
          }
        },
        {
          indexName: 'ProviderIndex',
          partitionKey: {
            name: 'aiProvider',
            type: dynamodb.AttributeType.STRING
          },
          sortKey: {
            name: 'timestamp',
            type: dynamodb.AttributeType.STRING
          }
        }
      ],
      
      // TTL for automatic cleanup (optional - for GDPR compliance)
      timeToLiveAttribute: 'expirationTime'
    });
  }

  private createAiProviderSecrets(projectName: string): void {
    // Create placeholder secrets for AI providers
    // These will need to be populated with actual API keys
    
    new secretsmanager.Secret(this, 'GoogleAiSecret', {
      secretName: `${projectName}/ai-providers/google`,
      description: 'Google Gemini API configuration',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          provider: 'google',
          model: 'gemini-pro',
          maxTokens: 2048,
          temperature: 0.7
        }),
        generateStringKey: 'apiKey',
        passwordLength: 64,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\'
      }
    });

    new secretsmanager.Secret(this, 'MicrosoftAiSecret', {
      secretName: `${projectName}/ai-providers/microsoft`,
      description: 'Microsoft Copilot API configuration',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          provider: 'microsoft',
          azureEndpoint: 'https://your-resource.openai.azure.com/',
          deploymentName: 'gpt-4',
          apiVersion: '2024-02-15-preview',
          maxTokens: 2048,
          temperature: 0.7
        }),
        generateStringKey: 'apiKey',
        passwordLength: 64,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\'
      }
    });

    new secretsmanager.Secret(this, 'BedrockConfigSecret', {
      secretName: `${projectName}/ai-providers/bedrock`,
      description: 'Amazon Bedrock configuration',
      secretObjectValue: {
        provider: cdk.SecretValue.unsafePlainText('bedrock'),
        region: cdk.SecretValue.unsafePlainText('eu-west-2'),
        modelId: cdk.SecretValue.unsafePlainText('anthropic.claude-3-sonnet-20240229-v1:0'),
        maxTokens: cdk.SecretValue.unsafePlainText('2048'),
        temperature: cdk.SecretValue.unsafePlainText('0.7')
      }
    });

    // Session secret for application
    new secretsmanager.Secret(this, 'SessionSecret', {
      secretName: `${projectName}/session-secret`,
      description: 'Session secret for Express.js application',
      generateSecretString: {
        passwordLength: 64,
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\'
      }
    });
  }

  private createAiOrchestrationFunction(
    projectName: string,
    vpc: ec2.IVpc,
    securityGroup: ec2.ISecurityGroup,
    role: iam.IRole
  ): lambda.Function {
    
    const logGroup = new logs.LogGroup(this, 'AiOrchestrationLogGroup', {
      logGroupName: `/aws/lambda/${projectName}-ai-orchestration`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    return new lambda.Function(this, 'AiOrchestrationFunction', {
      functionName: `${projectName}-ai-orchestration`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      
      environment: {
        AI_AUDIT_TABLE: this.aiAuditTable.tableName,
        PROJECT_NAME: projectName,
        REGION: this.region
      },
      
      logGroup,
      
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const dynamodb = new AWS.DynamoDB.DocumentClient();
        const lambda = new AWS.Lambda();
        
        exports.handler = async (event) => {
          console.log('AI Orchestration request:', JSON.stringify(event, null, 2));
          
          try {
            const { organizationId, userId, prompt, context, aiProvider } = event;
            
            // Validate request
            if (!organizationId || !prompt) {
              throw new Error('Missing required parameters: organizationId, prompt');
            }
            
            // Route to appropriate AI provider function
            let targetFunction;
            switch (aiProvider) {
              case 'google':
                targetFunction = '${projectName}-google-gemini';
                break;
              case 'microsoft':
                targetFunction = '${projectName}-microsoft-copilot';
                break;
              case 'bedrock':
                targetFunction = '${projectName}-bedrock';
                break;
              default:
                targetFunction = '${projectName}-google-gemini'; // Default to Google
            }
            
            // Enhance prompt with educational context
            const enhancedPrompt = enhanceEducationalPrompt(prompt, context);
            
            // Invoke AI provider function
            const providerResult = await lambda.invoke({
              FunctionName: targetFunction,
              Payload: JSON.stringify({
                organizationId,
                prompt: enhancedPrompt,
                context
              })
            }).promise();
            
            const aiResponse = JSON.parse(providerResult.Payload);
            
            // Apply content safety filters
            const filteredResponse = await applySafetyFilters(aiResponse.response);
            
            // Log interaction for audit
            await logAiInteraction({
              organizationId,
              userId,
              aiProvider,
              prompt,
              response: filteredResponse,
              context,
              timestamp: new Date().toISOString()
            });
            
            return {
              statusCode: 200,
              body: JSON.stringify({
                response: filteredResponse,
                provider: aiProvider,
                context
              })
            };
            
          } catch (error) {
            console.error('AI orchestration error:', error);
            return {
              statusCode: 500,
              body: JSON.stringify({
                error: 'AI processing failed',
                message: error.message
              })
            };
          }
        };
        
        function enhanceEducationalPrompt(prompt, context) {
          const stage = context?.stage || 'TORCH';
          const subject = context?.subject || 'general';
          
          let enhancement = \`You are an AI assistant helping students develop critical thinking skills in the \${stage} stage of learning. \`;
          
          switch (stage) {
            case 'MAP':
              enhancement += 'Help the student plan their inquiry and set clear objectives. Encourage them to think about what they want to learn and how they might approach their research.';
              break;
            case 'TORCH':
              enhancement += 'Guide the student to ask better questions and think critically about their topic. Do not provide direct answers - instead, help them formulate thoughtful questions.';
              break;
            case 'COMPASS':
              enhancement += 'Help the student evaluate sources and verify information. Encourage critical evaluation of evidence and consideration of multiple perspectives.';
              break;
          }
          
          enhancement += \` The subject area is \${subject}. Student query: \${prompt}\`;
          
          return enhancement;
        }
        
        function applySafetyFilters(response) {
          // Basic content filtering - would be enhanced with proper safety services
          const forbiddenPatterns = [
            /harmful content/i,
            /inappropriate/i
          ];
          
          let filtered = response;
          forbiddenPatterns.forEach(pattern => {
            if (pattern.test(filtered)) {
              filtered = 'I cannot provide that information. Please try rephrasing your question in an educational context.';
            }
          });
          
          return filtered;
        }
        
        async function logAiInteraction(interaction) {
          const params = {
            TableName: process.env.AI_AUDIT_TABLE,
            Item: {
              organizationId: interaction.organizationId,
              timestamp: interaction.timestamp,
              userId: interaction.userId,
              aiProvider: interaction.aiProvider,
              prompt: interaction.prompt,
              response: interaction.response,
              context: interaction.context,
              expirationTime: Math.floor(Date.now() / 1000) + (365 * 24 * 60 * 60) // 1 year TTL
            }
          };
          
          return dynamodb.put(params).promise();
        }
      `)
    });
  }

  private createGoogleGeminiFunction(
    projectName: string,
    vpc: ec2.IVpc,
    securityGroup: ec2.ISecurityGroup,
    role: iam.IRole
  ): lambda.Function {
    
    return new lambda.Function(this, 'GoogleGeminiFunction', {
      functionName: `${projectName}-google-gemini`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      
      environment: {
        SECRET_NAME: `${projectName}/ai-providers/google`
      },
      
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const https = require('https');
        const secretsManager = new AWS.SecretsManager();
        
        exports.handler = async (event) => {
          try {
            // Get Google AI API key from Secrets Manager
            const secret = await secretsManager.getSecretValue({
              SecretId: process.env.SECRET_NAME
            }).promise();
            
            const config = JSON.parse(secret.SecretString);
            
            // Call Google Gemini API (placeholder implementation)
            const response = await callGoogleGeminiAPI(event.prompt, config);
            
            return {
              statusCode: 200,
              response: response
            };
            
          } catch (error) {
            console.error('Google Gemini error:', error);
            throw error;
          }
        };
        
        async function callGoogleGeminiAPI(prompt, config) {
          // Placeholder implementation - would use actual Google Gemini API
          return \`This is a simulated response from Google Gemini for: \${prompt}. Please implement actual API integration.\`;
        }
      `)
    });
  }

  private createMicrosoftCopilotFunction(
    projectName: string,
    vpc: ec2.IVpc,
    securityGroup: ec2.ISecurityGroup,
    role: iam.IRole
  ): lambda.Function {
    
    return new lambda.Function(this, 'MicrosoftCopilotFunction', {
      functionName: `${projectName}-microsoft-copilot`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      
      environment: {
        SECRET_NAME: `${projectName}/ai-providers/microsoft`
      },
      
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const secretsManager = new AWS.SecretsManager();
        
        exports.handler = async (event) => {
          try {
            // Get Microsoft AI API configuration from Secrets Manager
            const secret = await secretsManager.getSecretValue({
              SecretId: process.env.SECRET_NAME
            }).promise();
            
            const config = JSON.parse(secret.SecretString);
            
            // Call Microsoft Copilot API (placeholder implementation)
            const response = await callMicrosoftCopilotAPI(event.prompt, config);
            
            return {
              statusCode: 200,
              response: response
            };
            
          } catch (error) {
            console.error('Microsoft Copilot error:', error);
            throw error;
          }
        };
        
        async function callMicrosoftCopilotAPI(prompt, config) {
          // Placeholder implementation - would use actual Microsoft Azure OpenAI API
          return \`This is a simulated response from Microsoft Copilot for: \${prompt}. Please implement actual API integration.\`;
        }
      `)
    });
  }

  private createBedrockFunction(
    projectName: string,
    vpc: ec2.IVpc,
    securityGroup: ec2.ISecurityGroup,
    role: iam.IRole
  ): lambda.Function {
    
    return new lambda.Function(this, 'BedrockFunction', {
      functionName: `${projectName}-bedrock`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      role,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [securityGroup],
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      
      environment: {
        SECRET_NAME: `${projectName}/ai-providers/bedrock`,
        REGION: this.region
      },
      
      code: lambda.Code.fromInline(`
        const AWS = require('aws-sdk');
        const bedrock = new AWS.BedrockRuntime({ region: process.env.REGION });
        const secretsManager = new AWS.SecretsManager();
        
        exports.handler = async (event) => {
          try {
            // Get Bedrock configuration from Secrets Manager
            const secret = await secretsManager.getSecretValue({
              SecretId: process.env.SECRET_NAME
            }).promise();
            
            const config = JSON.parse(secret.SecretString);
            
            // Call Amazon Bedrock API
            const response = await callBedrockAPI(event.prompt, config);
            
            return {
              statusCode: 200,
              response: response
            };
            
          } catch (error) {
            console.error('Bedrock error:', error);
            throw error;
          }
        };
        
        async function callBedrockAPI(prompt, config) {
          try {
            const params = {
              modelId: config.modelId,
              contentType: 'application/json',
              accept: 'application/json',
              body: JSON.stringify({
                prompt: \`Human: \${prompt}\\n\\nAssistant:\`,
                max_tokens_to_sample: parseInt(config.maxTokens),
                temperature: parseFloat(config.temperature),
                stop_sequences: ['\\n\\nHuman:']
              })
            };
            
            const result = await bedrock.invokeModel(params).promise();
            const response = JSON.parse(Buffer.from(result.body).toString());
            
            return response.completion || 'No response generated';
            
          } catch (error) {
            console.error('Bedrock API error:', error);
            return \`This is a simulated response from Amazon Bedrock for: \${prompt}. Bedrock may not be available in your region or account.\`;
          }
        }
      `)
    });
  }

  private createOutputs(): void {
    // Lambda function outputs
    new cdk.CfnOutput(this, 'AiOrchestrationFunctionArn', {
      value: this.aiOrchestrationFunction.functionArn,
      description: 'ARN of the AI orchestration Lambda function',
      exportName: 'AssistedClimbAiOrchestrationFunctionArn'
    });

    new cdk.CfnOutput(this, 'GoogleGeminiFunctionArn', {
      value: this.googleGeminiFunction.functionArn,
      description: 'ARN of the Google Gemini Lambda function',
      exportName: 'AssistedClimbGoogleGeminiFunctionArn'
    });

    new cdk.CfnOutput(this, 'MicrosoftCopilotFunctionArn', {
      value: this.microsoftCopilotFunction.functionArn,
      description: 'ARN of the Microsoft Copilot Lambda function',
      exportName: 'AssistedClimbMicrosoftCopilotFunctionArn'
    });

    new cdk.CfnOutput(this, 'BedrockFunctionArn', {
      value: this.bedrockFunction.functionArn,
      description: 'ARN of the Amazon Bedrock Lambda function',
      exportName: 'AssistedClimbBedrockFunctionArn'
    });

    // DynamoDB table output
    new cdk.CfnOutput(this, 'AiAuditTableName', {
      value: this.aiAuditTable.tableName,
      description: 'Name of the AI audit DynamoDB table',
      exportName: 'AssistedClimbAiAuditTableName'
    });

    new cdk.CfnOutput(this, 'AiAuditTableArn', {
      value: this.aiAuditTable.tableArn,
      description: 'ARN of the AI audit DynamoDB table',
      exportName: 'AssistedClimbAiAuditTableArn'
    });

    // Configuration instructions
    new cdk.CfnOutput(this, 'ConfigurationInstructions', {
      value: 'Please update the AI provider secrets with actual API keys using AWS CLI or Console',
      description: 'Next steps for configuring AI providers'
    });
  }
}