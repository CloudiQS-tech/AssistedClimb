"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IamRolesStack = void 0;
const cdk = require("aws-cdk-lib");
const iam = require("aws-cdk-lib/aws-iam");
class IamRolesStack extends cdk.Stack {
    constructor(scope, id, props = {}) {
        super(scope, id, props);
        const { environment = 'development', projectName = 'assisted-climb' } = props;
        // Create ECS Task Execution Role
        this.ecsTaskExecutionRole = this.createEcsTaskExecutionRole(projectName);
        // Create ECS Task Role for application access to AWS services
        this.ecsTaskRole = this.createEcsTaskRole(projectName);
        // Create Lambda Execution Role for AI orchestration
        this.lambdaExecutionRole = this.createLambdaExecutionRole(projectName);
        // Create RDS monitoring role
        this.rdsMonitoringRole = this.createRdsMonitoringRole(projectName);
        // Create RDS backup role
        this.rdsBackupRole = this.createRdsBackupRole(projectName);
        // Add common tags to all roles
        this.addCommonTags(environment, projectName);
        // Create outputs for role ARNs
        this.createOutputs();
    }
    createEcsTaskExecutionRole(projectName) {
        const role = new iam.Role(this, 'EcsTaskExecutionRole', {
            roleName: `${projectName}-ecs-task-execution-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'ECS Task Execution Role for Assisted CLIMB containers with minimal permissions for container management'
        });
        // Add AWS managed policy for ECS task execution
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'));
        // Add specific permissions for CloudWatch Logs
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogStreams'
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/ecs/${projectName}*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/ecs/${projectName}*:*`
            ]
        }));
        // Add permissions for ECR access (pulling container images)
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'ecr:GetAuthorizationToken',
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage'
            ],
            resources: ['*'] // ECR requires wildcard for GetAuthorizationToken
        }));
        return role;
    }
    createEcsTaskRole(projectName) {
        const role = new iam.Role(this, 'EcsTaskRole', {
            roleName: `${projectName}-ecs-task-role`,
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
            description: 'ECS Task Role for application access to AWS services (RDS, S3, Secrets Manager)'
        });
        // Secrets Manager access for application configuration
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret'
            ],
            resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/*`
            ]
        }));
        // S3 access for static assets and backups
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:GetObject',
                's3:GetObjectVersion',
                's3:PutObject',
                's3:DeleteObject',
                's3:ListBucket'
            ],
            resources: [
                `arn:aws:s3:::${projectName}-static-assets`,
                `arn:aws:s3:::${projectName}-static-assets/*`,
                `arn:aws:s3:::${projectName}-backups`,
                `arn:aws:s3:::${projectName}-backups/*`
            ]
        }));
        // CloudWatch Logs for application logging
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams'
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/ecs/${projectName}*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/ecs/${projectName}*:*`
            ]
        }));
        // Lambda invoke permissions for AI orchestration
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'lambda:InvokeFunction'
            ],
            resources: [
                `arn:aws:lambda:${this.region}:${this.account}:function:${projectName}-ai-*`
            ]
        }));
        // CloudWatch metrics for monitoring
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:PutMetricData'
            ],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'cloudwatch:namespace': `AssistedCLIMB/${projectName}`
                }
            }
        }));
        return role;
    }
    createLambdaExecutionRole(projectName) {
        const role = new iam.Role(this, 'LambdaExecutionRole', {
            roleName: `${projectName}-lambda-execution-role`,
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
            description: 'Lambda Execution Role for AI orchestration functions with access to Secrets Manager and logging'
        });
        // Add AWS managed policy for Lambda basic execution
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'));
        // Add VPC execution policy for Lambda functions in VPC
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'));
        // Secrets Manager access for AI API keys
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:DescribeSecret'
            ],
            resources: [
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/ai-providers/*`,
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/google-ai-key*`,
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/azure-ai-key*`,
                `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/bedrock-config*`
            ]
        }));
        // Amazon Bedrock access for AWS native AI
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'bedrock:InvokeModel',
                'bedrock:InvokeModelWithResponseStream',
                'bedrock:ListFoundationModels',
                'bedrock:GetFoundationModel'
            ],
            resources: [
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-sonnet-*`,
                `arn:aws:bedrock:${this.region}::foundation-model/anthropic.claude-3-haiku-*`,
                `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-*`
            ]
        }));
        // CloudWatch Logs for Lambda function logging
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents'
            ],
            resources: [
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${projectName}-*`,
                `arn:aws:logs:${this.region}:${this.account}:log-group:/aws/lambda/${projectName}-*:*`
            ]
        }));
        // DynamoDB access for AI interaction audit logging
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'dynamodb:PutItem',
                'dynamodb:UpdateItem',
                'dynamodb:GetItem',
                'dynamodb:Query',
                'dynamodb:BatchWriteItem'
            ],
            resources: [
                `arn:aws:dynamodb:${this.region}:${this.account}:table/${projectName}-ai-audit-log`,
                `arn:aws:dynamodb:${this.region}:${this.account}:table/${projectName}-ai-audit-log/index/*`
            ]
        }));
        // CloudWatch metrics for Lambda monitoring
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:PutMetricData'
            ],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'cloudwatch:namespace': `AssistedCLIMB/Lambda`
                }
            }
        }));
        return role;
    }
    createRdsMonitoringRole(projectName) {
        const role = new iam.Role(this, 'RdsMonitoringRole', {
            roleName: `${projectName}-rds-monitoring-role`,
            assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
            description: 'RDS Enhanced Monitoring Role for database performance monitoring'
        });
        // Add AWS managed policy for RDS enhanced monitoring
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole'));
        // Additional CloudWatch permissions for custom metrics
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'cloudwatch:PutMetricData',
                'cloudwatch:ListMetrics',
                'cloudwatch:GetMetricStatistics'
            ],
            resources: ['*'],
            conditions: {
                StringEquals: {
                    'cloudwatch:namespace': [
                        'AWS/RDS',
                        `AssistedCLIMB/Database`
                    ]
                }
            }
        }));
        return role;
    }
    createRdsBackupRole(projectName) {
        const role = new iam.Role(this, 'RdsBackupRole', {
            roleName: `${projectName}-rds-backup-role`,
            assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
            description: 'RDS Backup Role for automated database backups and point-in-time recovery'
        });
        // Add AWS managed policy for AWS Backup service role
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup'));
        role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores'));
        // S3 permissions for backup storage
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                's3:PutObject',
                's3:GetObject',
                's3:DeleteObject',
                's3:ListBucket',
                's3:GetBucketVersioning',
                's3:PutBucketVersioning'
            ],
            resources: [
                `arn:aws:s3:::${projectName}-backups`,
                `arn:aws:s3:::${projectName}-backups/*`
            ]
        }));
        // RDS specific backup permissions
        role.addToPolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'rds:CreateDBSnapshot',
                'rds:CreateDBClusterSnapshot',
                'rds:DescribeDBSnapshots',
                'rds:DescribeDBClusterSnapshots',
                'rds:CopyDBSnapshot',
                'rds:CopyDBClusterSnapshot',
                'rds:DeleteDBSnapshot',
                'rds:DeleteDBClusterSnapshot'
            ],
            resources: [
                `arn:aws:rds:${this.region}:${this.account}:db:${projectName}-*`,
                `arn:aws:rds:${this.region}:${this.account}:cluster:${projectName}-*`,
                `arn:aws:rds:${this.region}:${this.account}:snapshot:${projectName}-*`,
                `arn:aws:rds:${this.region}:${this.account}:cluster-snapshot:${projectName}-*`
            ]
        }));
        return role;
    }
    addCommonTags(environment, projectName) {
        const commonTags = {
            Project: 'Assisted-CLIMB',
            Environment: environment,
            Component: 'IAM-Roles',
            CostCenter: 'Education-Technology',
            Owner: 'assisted-climb-team',
            Purpose: 'AWS-Migration-Security',
            Compliance: 'GDPR-UKGDPR'
        };
        // Apply tags to all resources in this stack
        cdk.Tags.of(this).add('Project', commonTags.Project);
        cdk.Tags.of(this).add('Environment', commonTags.Environment);
        cdk.Tags.of(this).add('Component', commonTags.Component);
        cdk.Tags.of(this).add('CostCenter', commonTags.CostCenter);
        cdk.Tags.of(this).add('Owner', commonTags.Owner);
        cdk.Tags.of(this).add('Purpose', commonTags.Purpose);
        cdk.Tags.of(this).add('Compliance', commonTags.Compliance);
    }
    createOutputs() {
        // ECS Task Execution Role outputs
        new cdk.CfnOutput(this, 'EcsTaskExecutionRoleArn', {
            value: this.ecsTaskExecutionRole.roleArn,
            description: 'ARN of the ECS Task Execution Role for container management',
            exportName: 'AssistedClimbEcsTaskExecutionRoleArn'
        });
        new cdk.CfnOutput(this, 'EcsTaskExecutionRoleName', {
            value: this.ecsTaskExecutionRole.roleName,
            description: 'Name of the ECS Task Execution Role',
            exportName: 'AssistedClimbEcsTaskExecutionRoleName'
        });
        // ECS Task Role outputs
        new cdk.CfnOutput(this, 'EcsTaskRoleArn', {
            value: this.ecsTaskRole.roleArn,
            description: 'ARN of the ECS Task Role for application AWS service access',
            exportName: 'AssistedClimbEcsTaskRoleArn'
        });
        new cdk.CfnOutput(this, 'EcsTaskRoleName', {
            value: this.ecsTaskRole.roleName,
            description: 'Name of the ECS Task Role',
            exportName: 'AssistedClimbEcsTaskRoleName'
        });
        // Lambda Execution Role outputs
        new cdk.CfnOutput(this, 'LambdaExecutionRoleArn', {
            value: this.lambdaExecutionRole.roleArn,
            description: 'ARN of the Lambda Execution Role for AI orchestration',
            exportName: 'AssistedClimbLambdaExecutionRoleArn'
        });
        new cdk.CfnOutput(this, 'LambdaExecutionRoleName', {
            value: this.lambdaExecutionRole.roleName,
            description: 'Name of the Lambda Execution Role',
            exportName: 'AssistedClimbLambdaExecutionRoleName'
        });
        // RDS Monitoring Role outputs
        new cdk.CfnOutput(this, 'RdsMonitoringRoleArn', {
            value: this.rdsMonitoringRole.roleArn,
            description: 'ARN of the RDS Monitoring Role for enhanced monitoring',
            exportName: 'AssistedClimbRdsMonitoringRoleArn'
        });
        // RDS Backup Role outputs
        new cdk.CfnOutput(this, 'RdsBackupRoleArn', {
            value: this.rdsBackupRole.roleArn,
            description: 'ARN of the RDS Backup Role for automated backups',
            exportName: 'AssistedClimbRdsBackupRoleArn'
        });
        // Summary output with all role information
        new cdk.CfnOutput(this, 'IamRolesSummary', {
            value: JSON.stringify({
                ecsTaskExecutionRole: this.ecsTaskExecutionRole.roleName,
                ecsTaskRole: this.ecsTaskRole.roleName,
                lambdaExecutionRole: this.lambdaExecutionRole.roleName,
                rdsMonitoringRole: this.rdsMonitoringRole.roleName,
                rdsBackupRole: this.rdsBackupRole.roleName
            }),
            description: 'JSON summary of all created IAM roles for reference'
        });
    }
}
exports.IamRolesStack = IamRolesStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaWFtLXJvbGVzLXN0YWNrLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiaWFtLXJvbGVzLXN0YWNrLnRzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBLG1DQUFtQztBQUNuQywyQ0FBMkM7QUFpQjNDLE1BQWEsYUFBYyxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBTzFDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBNEIsRUFBRTtRQUN0RSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLEVBQ0osV0FBVyxHQUFHLGFBQWEsRUFDM0IsV0FBVyxHQUFHLGdCQUFnQixFQUMvQixHQUFHLEtBQUssQ0FBQztRQUVWLGlDQUFpQztRQUNqQyxJQUFJLENBQUMsb0JBQW9CLEdBQUcsSUFBSSxDQUFDLDBCQUEwQixDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBRXpFLDhEQUE4RDtRQUM5RCxJQUFJLENBQUMsV0FBVyxHQUFHLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUV2RCxvREFBb0Q7UUFDcEQsSUFBSSxDQUFDLG1CQUFtQixHQUFHLElBQUksQ0FBQyx5QkFBeUIsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUV2RSw2QkFBNkI7UUFDN0IsSUFBSSxDQUFDLGlCQUFpQixHQUFHLElBQUksQ0FBQyx1QkFBdUIsQ0FBQyxXQUFXLENBQUMsQ0FBQztRQUVuRSx5QkFBeUI7UUFDekIsSUFBSSxDQUFDLGFBQWEsR0FBRyxJQUFJLENBQUMsbUJBQW1CLENBQUMsV0FBVyxDQUFDLENBQUM7UUFFM0QsK0JBQStCO1FBQy9CLElBQUksQ0FBQyxhQUFhLENBQUMsV0FBVyxFQUFFLFdBQVcsQ0FBQyxDQUFDO1FBRTdDLCtCQUErQjtRQUMvQixJQUFJLENBQUMsYUFBYSxFQUFFLENBQUM7SUFDdkIsQ0FBQztJQUVPLDBCQUEwQixDQUFDLFdBQW1CO1FBQ3BELE1BQU0sSUFBSSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDdEQsUUFBUSxFQUFFLEdBQUcsV0FBVywwQkFBMEI7WUFDbEQsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHlCQUF5QixDQUFDO1lBQzlELFdBQVcsRUFBRSx5R0FBeUc7U0FDdkgsQ0FBQyxDQUFDO1FBRUgsZ0RBQWdEO1FBQ2hELElBQUksQ0FBQyxnQkFBZ0IsQ0FDbkIsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQywrQ0FBK0MsQ0FBQyxDQUM1RixDQUFDO1FBRUYsK0NBQStDO1FBQy9DLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLHFCQUFxQjtnQkFDckIsc0JBQXNCO2dCQUN0QixtQkFBbUI7Z0JBQ25CLHlCQUF5QjthQUMxQjtZQUNELFNBQVMsRUFBRTtnQkFDVCxnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyx1QkFBdUIsV0FBVyxHQUFHO2dCQUNoRixnQkFBZ0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyx1QkFBdUIsV0FBVyxLQUFLO2FBQ25GO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSiw0REFBNEQ7UUFDNUQsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsMkJBQTJCO2dCQUMzQixpQ0FBaUM7Z0JBQ2pDLDRCQUE0QjtnQkFDNUIsbUJBQW1CO2FBQ3BCO1lBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDLENBQUMsa0RBQWtEO1NBQ3BFLENBQUMsQ0FBQyxDQUFDO1FBRUosT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRU8saUJBQWlCLENBQUMsV0FBbUI7UUFDM0MsTUFBTSxJQUFJLEdBQUcsSUFBSSxHQUFHLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxhQUFhLEVBQUU7WUFDN0MsUUFBUSxFQUFFLEdBQUcsV0FBVyxnQkFBZ0I7WUFDeEMsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHlCQUF5QixDQUFDO1lBQzlELFdBQVcsRUFBRSxpRkFBaUY7U0FDL0YsQ0FBQyxDQUFDO1FBRUgsdURBQXVEO1FBQ3ZELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLCtCQUErQjtnQkFDL0IsK0JBQStCO2FBQ2hDO1lBQ0QsU0FBUyxFQUFFO2dCQUNULDBCQUEwQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFdBQVcsV0FBVyxJQUFJO2FBQ2hGO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSiwwQ0FBMEM7UUFDMUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsY0FBYztnQkFDZCxxQkFBcUI7Z0JBQ3JCLGNBQWM7Z0JBQ2QsaUJBQWlCO2dCQUNqQixlQUFlO2FBQ2hCO1lBQ0QsU0FBUyxFQUFFO2dCQUNULGdCQUFnQixXQUFXLGdCQUFnQjtnQkFDM0MsZ0JBQWdCLFdBQVcsa0JBQWtCO2dCQUM3QyxnQkFBZ0IsV0FBVyxVQUFVO2dCQUNyQyxnQkFBZ0IsV0FBVyxZQUFZO2FBQ3hDO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSiwwQ0FBMEM7UUFDMUMsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AscUJBQXFCO2dCQUNyQixzQkFBc0I7Z0JBQ3RCLG1CQUFtQjtnQkFDbkIsd0JBQXdCO2dCQUN4Qix5QkFBeUI7YUFDMUI7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sdUJBQXVCLFdBQVcsR0FBRztnQkFDaEYsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sdUJBQXVCLFdBQVcsS0FBSzthQUNuRjtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosaURBQWlEO1FBQ2pELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLHVCQUF1QjthQUN4QjtZQUNELFNBQVMsRUFBRTtnQkFDVCxrQkFBa0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyxhQUFhLFdBQVcsT0FBTzthQUM3RTtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosb0NBQW9DO1FBQ3BDLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLDBCQUEwQjthQUMzQjtZQUNELFNBQVMsRUFBRSxDQUFDLEdBQUcsQ0FBQztZQUNoQixVQUFVLEVBQUU7Z0JBQ1YsWUFBWSxFQUFFO29CQUNaLHNCQUFzQixFQUFFLGlCQUFpQixXQUFXLEVBQUU7aUJBQ3ZEO2FBQ0Y7U0FDRixDQUFDLENBQUMsQ0FBQztRQUVKLE9BQU8sSUFBSSxDQUFDO0lBQ2QsQ0FBQztJQUVPLHlCQUF5QixDQUFDLFdBQW1CO1FBQ25ELE1BQU0sSUFBSSxHQUFHLElBQUksR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLEVBQUUscUJBQXFCLEVBQUU7WUFDckQsUUFBUSxFQUFFLEdBQUcsV0FBVyx3QkFBd0I7WUFDaEQsU0FBUyxFQUFFLElBQUksR0FBRyxDQUFDLGdCQUFnQixDQUFDLHNCQUFzQixDQUFDO1lBQzNELFdBQVcsRUFBRSxpR0FBaUc7U0FDL0csQ0FBQyxDQUFDO1FBRUgsb0RBQW9EO1FBQ3BELElBQUksQ0FBQyxnQkFBZ0IsQ0FDbkIsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQywwQ0FBMEMsQ0FBQyxDQUN2RixDQUFDO1FBRUYsdURBQXVEO1FBQ3ZELElBQUksQ0FBQyxnQkFBZ0IsQ0FDbkIsR0FBRyxDQUFDLGFBQWEsQ0FBQyx3QkFBd0IsQ0FBQyw4Q0FBOEMsQ0FBQyxDQUMzRixDQUFDO1FBRUYseUNBQXlDO1FBQ3pDLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLCtCQUErQjtnQkFDL0IsK0JBQStCO2FBQ2hDO1lBQ0QsU0FBUyxFQUFFO2dCQUNULDBCQUEwQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFdBQVcsV0FBVyxpQkFBaUI7Z0JBQzVGLDBCQUEwQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFdBQVcsV0FBVyxpQkFBaUI7Z0JBQzVGLDBCQUEwQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFdBQVcsV0FBVyxnQkFBZ0I7Z0JBQzNGLDBCQUEwQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFdBQVcsV0FBVyxrQkFBa0I7YUFDOUY7U0FDRixDQUFDLENBQUMsQ0FBQztRQUVKLDBDQUEwQztRQUMxQyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN2QyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxxQkFBcUI7Z0JBQ3JCLHVDQUF1QztnQkFDdkMsOEJBQThCO2dCQUM5Qiw0QkFBNEI7YUFDN0I7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsbUJBQW1CLElBQUksQ0FBQyxNQUFNLGdEQUFnRDtnQkFDOUUsbUJBQW1CLElBQUksQ0FBQyxNQUFNLCtDQUErQztnQkFDN0UsbUJBQW1CLElBQUksQ0FBQyxNQUFNLG1DQUFtQzthQUNsRTtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosOENBQThDO1FBQzlDLElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLHFCQUFxQjtnQkFDckIsc0JBQXNCO2dCQUN0QixtQkFBbUI7YUFDcEI7WUFDRCxTQUFTLEVBQUU7Z0JBQ1QsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sMEJBQTBCLFdBQVcsSUFBSTtnQkFDcEYsZ0JBQWdCLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sMEJBQTBCLFdBQVcsTUFBTTthQUN2RjtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosbURBQW1EO1FBQ25ELElBQUksQ0FBQyxXQUFXLENBQUMsSUFBSSxHQUFHLENBQUMsZUFBZSxDQUFDO1lBQ3ZDLE1BQU0sRUFBRSxHQUFHLENBQUMsTUFBTSxDQUFDLEtBQUs7WUFDeEIsT0FBTyxFQUFFO2dCQUNQLGtCQUFrQjtnQkFDbEIscUJBQXFCO2dCQUNyQixrQkFBa0I7Z0JBQ2xCLGdCQUFnQjtnQkFDaEIseUJBQXlCO2FBQzFCO1lBQ0QsU0FBUyxFQUFFO2dCQUNULG9CQUFvQixJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLFVBQVUsV0FBVyxlQUFlO2dCQUNuRixvQkFBb0IsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyxVQUFVLFdBQVcsdUJBQXVCO2FBQzVGO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSiwyQ0FBMkM7UUFDM0MsSUFBSSxDQUFDLFdBQVcsQ0FBQyxJQUFJLEdBQUcsQ0FBQyxlQUFlLENBQUM7WUFDdkMsTUFBTSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsS0FBSztZQUN4QixPQUFPLEVBQUU7Z0JBQ1AsMEJBQTBCO2FBQzNCO1lBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO1lBQ2hCLFVBQVUsRUFBRTtnQkFDVixZQUFZLEVBQUU7b0JBQ1osc0JBQXNCLEVBQUUsc0JBQXNCO2lCQUMvQzthQUNGO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSixPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFTyx1QkFBdUIsQ0FBQyxXQUFtQjtRQUNqRCxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLG1CQUFtQixFQUFFO1lBQ25ELFFBQVEsRUFBRSxHQUFHLFdBQVcsc0JBQXNCO1lBQzlDLFNBQVMsRUFBRSxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyw4QkFBOEIsQ0FBQztZQUNuRSxXQUFXLEVBQUUsa0VBQWtFO1NBQ2hGLENBQUMsQ0FBQztRQUVILHFEQUFxRDtRQUNyRCxJQUFJLENBQUMsZ0JBQWdCLENBQ25CLEdBQUcsQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsOENBQThDLENBQUMsQ0FDM0YsQ0FBQztRQUVGLHVEQUF1RDtRQUN2RCxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN2QyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCwwQkFBMEI7Z0JBQzFCLHdCQUF3QjtnQkFDeEIsZ0NBQWdDO2FBQ2pDO1lBQ0QsU0FBUyxFQUFFLENBQUMsR0FBRyxDQUFDO1lBQ2hCLFVBQVUsRUFBRTtnQkFDVixZQUFZLEVBQUU7b0JBQ1osc0JBQXNCLEVBQUU7d0JBQ3RCLFNBQVM7d0JBQ1Qsd0JBQXdCO3FCQUN6QjtpQkFDRjthQUNGO1NBQ0YsQ0FBQyxDQUFDLENBQUM7UUFFSixPQUFPLElBQUksQ0FBQztJQUNkLENBQUM7SUFFTyxtQkFBbUIsQ0FBQyxXQUFtQjtRQUM3QyxNQUFNLElBQUksR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRTtZQUMvQyxRQUFRLEVBQUUsR0FBRyxXQUFXLGtCQUFrQjtZQUMxQyxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMsc0JBQXNCLENBQUM7WUFDM0QsV0FBVyxFQUFFLDJFQUEyRTtTQUN6RixDQUFDLENBQUM7UUFFSCxxREFBcUQ7UUFDckQsSUFBSSxDQUFDLGdCQUFnQixDQUNuQixHQUFHLENBQUMsYUFBYSxDQUFDLHdCQUF3QixDQUFDLGtEQUFrRCxDQUFDLENBQy9GLENBQUM7UUFFRixJQUFJLENBQUMsZ0JBQWdCLENBQ25CLEdBQUcsQ0FBQyxhQUFhLENBQUMsd0JBQXdCLENBQUMsb0RBQW9ELENBQUMsQ0FDakcsQ0FBQztRQUVGLG9DQUFvQztRQUNwQyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN2QyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxjQUFjO2dCQUNkLGNBQWM7Z0JBQ2QsaUJBQWlCO2dCQUNqQixlQUFlO2dCQUNmLHdCQUF3QjtnQkFDeEIsd0JBQXdCO2FBQ3pCO1lBQ0QsU0FBUyxFQUFFO2dCQUNULGdCQUFnQixXQUFXLFVBQVU7Z0JBQ3JDLGdCQUFnQixXQUFXLFlBQVk7YUFDeEM7U0FDRixDQUFDLENBQUMsQ0FBQztRQUVKLGtDQUFrQztRQUNsQyxJQUFJLENBQUMsV0FBVyxDQUFDLElBQUksR0FBRyxDQUFDLGVBQWUsQ0FBQztZQUN2QyxNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLO1lBQ3hCLE9BQU8sRUFBRTtnQkFDUCxzQkFBc0I7Z0JBQ3RCLDZCQUE2QjtnQkFDN0IseUJBQXlCO2dCQUN6QixnQ0FBZ0M7Z0JBQ2hDLG9CQUFvQjtnQkFDcEIsMkJBQTJCO2dCQUMzQixzQkFBc0I7Z0JBQ3RCLDZCQUE2QjthQUM5QjtZQUNELFNBQVMsRUFBRTtnQkFDVCxlQUFlLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8sT0FBTyxXQUFXLElBQUk7Z0JBQ2hFLGVBQWUsSUFBSSxDQUFDLE1BQU0sSUFBSSxJQUFJLENBQUMsT0FBTyxZQUFZLFdBQVcsSUFBSTtnQkFDckUsZUFBZSxJQUFJLENBQUMsTUFBTSxJQUFJLElBQUksQ0FBQyxPQUFPLGFBQWEsV0FBVyxJQUFJO2dCQUN0RSxlQUFlLElBQUksQ0FBQyxNQUFNLElBQUksSUFBSSxDQUFDLE9BQU8scUJBQXFCLFdBQVcsSUFBSTthQUMvRTtTQUNGLENBQUMsQ0FBQyxDQUFDO1FBRUosT0FBTyxJQUFJLENBQUM7SUFDZCxDQUFDO0lBRU8sYUFBYSxDQUFDLFdBQW1CLEVBQUUsV0FBbUI7UUFDNUQsTUFBTSxVQUFVLEdBQUc7WUFDakIsT0FBTyxFQUFFLGdCQUFnQjtZQUN6QixXQUFXLEVBQUUsV0FBVztZQUN4QixTQUFTLEVBQUUsV0FBVztZQUN0QixVQUFVLEVBQUUsc0JBQXNCO1lBQ2xDLEtBQUssRUFBRSxxQkFBcUI7WUFDNUIsT0FBTyxFQUFFLHdCQUF3QjtZQUNqQyxVQUFVLEVBQUUsYUFBYTtTQUMxQixDQUFDO1FBRUYsNENBQTRDO1FBQzVDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3JELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxhQUFhLEVBQUUsVUFBVSxDQUFDLFdBQVcsQ0FBQyxDQUFDO1FBQzdELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxXQUFXLEVBQUUsVUFBVSxDQUFDLFNBQVMsQ0FBQyxDQUFDO1FBQ3pELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxZQUFZLEVBQUUsVUFBVSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1FBQzNELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxPQUFPLEVBQUUsVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO1FBQ2pELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxTQUFTLEVBQUUsVUFBVSxDQUFDLE9BQU8sQ0FBQyxDQUFDO1FBQ3JELEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxDQUFDLElBQUksQ0FBQyxDQUFDLEdBQUcsQ0FBQyxZQUFZLEVBQUUsVUFBVSxDQUFDLFVBQVUsQ0FBQyxDQUFDO0lBQzdELENBQUM7SUFFTyxhQUFhO1FBQ25CLGtDQUFrQztRQUNsQyxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ2pELEtBQUssRUFBRSxJQUFJLENBQUMsb0JBQW9CLENBQUMsT0FBTztZQUN4QyxXQUFXLEVBQUUsNkRBQTZEO1lBQzFFLFVBQVUsRUFBRSxzQ0FBc0M7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSwwQkFBMEIsRUFBRTtZQUNsRCxLQUFLLEVBQUUsSUFBSSxDQUFDLG9CQUFvQixDQUFDLFFBQVE7WUFDekMsV0FBVyxFQUFFLHFDQUFxQztZQUNsRCxVQUFVLEVBQUUsdUNBQXVDO1NBQ3BELENBQUMsQ0FBQztRQUVILHdCQUF3QjtRQUN4QixJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFO1lBQ3hDLEtBQUssRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLE9BQU87WUFDL0IsV0FBVyxFQUFFLDZEQUE2RDtZQUMxRSxVQUFVLEVBQUUsNkJBQTZCO1NBQzFDLENBQUMsQ0FBQztRQUVILElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsaUJBQWlCLEVBQUU7WUFDekMsS0FBSyxFQUFFLElBQUksQ0FBQyxXQUFXLENBQUMsUUFBUTtZQUNoQyxXQUFXLEVBQUUsMkJBQTJCO1lBQ3hDLFVBQVUsRUFBRSw4QkFBOEI7U0FDM0MsQ0FBQyxDQUFDO1FBRUgsZ0NBQWdDO1FBQ2hDLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsd0JBQXdCLEVBQUU7WUFDaEQsS0FBSyxFQUFFLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxPQUFPO1lBQ3ZDLFdBQVcsRUFBRSx1REFBdUQ7WUFDcEUsVUFBVSxFQUFFLHFDQUFxQztTQUNsRCxDQUFDLENBQUM7UUFFSCxJQUFJLEdBQUcsQ0FBQyxTQUFTLENBQUMsSUFBSSxFQUFFLHlCQUF5QixFQUFFO1lBQ2pELEtBQUssRUFBRSxJQUFJLENBQUMsbUJBQW1CLENBQUMsUUFBUTtZQUN4QyxXQUFXLEVBQUUsbUNBQW1DO1lBQ2hELFVBQVUsRUFBRSxzQ0FBc0M7U0FDbkQsQ0FBQyxDQUFDO1FBRUgsOEJBQThCO1FBQzlCLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDOUMsS0FBSyxFQUFFLElBQUksQ0FBQyxpQkFBaUIsQ0FBQyxPQUFPO1lBQ3JDLFdBQVcsRUFBRSx3REFBd0Q7WUFDckUsVUFBVSxFQUFFLG1DQUFtQztTQUNoRCxDQUFDLENBQUM7UUFFSCwwQkFBMEI7UUFDMUIsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxrQkFBa0IsRUFBRTtZQUMxQyxLQUFLLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxPQUFPO1lBQ2pDLFdBQVcsRUFBRSxrREFBa0Q7WUFDL0QsVUFBVSxFQUFFLCtCQUErQjtTQUM1QyxDQUFDLENBQUM7UUFFSCwyQ0FBMkM7UUFDM0MsSUFBSSxHQUFHLENBQUMsU0FBUyxDQUFDLElBQUksRUFBRSxpQkFBaUIsRUFBRTtZQUN6QyxLQUFLLEVBQUUsSUFBSSxDQUFDLFNBQVMsQ0FBQztnQkFDcEIsb0JBQW9CLEVBQUUsSUFBSSxDQUFDLG9CQUFvQixDQUFDLFFBQVE7Z0JBQ3hELFdBQVcsRUFBRSxJQUFJLENBQUMsV0FBVyxDQUFDLFFBQVE7Z0JBQ3RDLG1CQUFtQixFQUFFLElBQUksQ0FBQyxtQkFBbUIsQ0FBQyxRQUFRO2dCQUN0RCxpQkFBaUIsRUFBRSxJQUFJLENBQUMsaUJBQWlCLENBQUMsUUFBUTtnQkFDbEQsYUFBYSxFQUFFLElBQUksQ0FBQyxhQUFhLENBQUMsUUFBUTthQUMzQyxDQUFDO1lBQ0YsV0FBVyxFQUFFLHFEQUFxRDtTQUNuRSxDQUFDLENBQUM7SUFDTCxDQUFDO0NBQ0Y7QUFqYkQsc0NBaWJDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ2F3cy1jZGstbGliJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuXG5leHBvcnQgaW50ZXJmYWNlIElhbVJvbGVzU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgLyoqXG4gICAqIEVudmlyb25tZW50IG5hbWUgZm9yIHJlc291cmNlIHRhZ2dpbmdcbiAgICogQGRlZmF1bHQgJ2RldmVsb3BtZW50J1xuICAgKi9cbiAgZW52aXJvbm1lbnQ/OiBzdHJpbmc7XG4gIFxuICAvKipcbiAgICogUHJvamVjdCBuYW1lIGZvciByZXNvdXJjZSBuYW1pbmdcbiAgICogQGRlZmF1bHQgJ2Fzc2lzdGVkLWNsaW1iJ1xuICAgKi9cbiAgcHJvamVjdE5hbWU/OiBzdHJpbmc7XG59XG5cbmV4cG9ydCBjbGFzcyBJYW1Sb2xlc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGVjc1Rhc2tFeGVjdXRpb25Sb2xlOiBpYW0uUm9sZTtcbiAgcHVibGljIHJlYWRvbmx5IGVjc1Rhc2tSb2xlOiBpYW0uUm9sZTtcbiAgcHVibGljIHJlYWRvbmx5IGxhbWJkYUV4ZWN1dGlvblJvbGU6IGlhbS5Sb2xlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmRzTW9uaXRvcmluZ1JvbGU6IGlhbS5Sb2xlO1xuICBwdWJsaWMgcmVhZG9ubHkgcmRzQmFja3VwUm9sZTogaWFtLlJvbGU7XG5cbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IElhbVJvbGVzU3RhY2tQcm9wcyA9IHt9KSB7XG4gICAgc3VwZXIoc2NvcGUsIGlkLCBwcm9wcyk7XG5cbiAgICBjb25zdCB7XG4gICAgICBlbnZpcm9ubWVudCA9ICdkZXZlbG9wbWVudCcsXG4gICAgICBwcm9qZWN0TmFtZSA9ICdhc3Npc3RlZC1jbGltYidcbiAgICB9ID0gcHJvcHM7XG5cbiAgICAvLyBDcmVhdGUgRUNTIFRhc2sgRXhlY3V0aW9uIFJvbGVcbiAgICB0aGlzLmVjc1Rhc2tFeGVjdXRpb25Sb2xlID0gdGhpcy5jcmVhdGVFY3NUYXNrRXhlY3V0aW9uUm9sZShwcm9qZWN0TmFtZSk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIEVDUyBUYXNrIFJvbGUgZm9yIGFwcGxpY2F0aW9uIGFjY2VzcyB0byBBV1Mgc2VydmljZXNcbiAgICB0aGlzLmVjc1Rhc2tSb2xlID0gdGhpcy5jcmVhdGVFY3NUYXNrUm9sZShwcm9qZWN0TmFtZSk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIExhbWJkYSBFeGVjdXRpb24gUm9sZSBmb3IgQUkgb3JjaGVzdHJhdGlvblxuICAgIHRoaXMubGFtYmRhRXhlY3V0aW9uUm9sZSA9IHRoaXMuY3JlYXRlTGFtYmRhRXhlY3V0aW9uUm9sZShwcm9qZWN0TmFtZSk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIFJEUyBtb25pdG9yaW5nIHJvbGVcbiAgICB0aGlzLnJkc01vbml0b3JpbmdSb2xlID0gdGhpcy5jcmVhdGVSZHNNb25pdG9yaW5nUm9sZShwcm9qZWN0TmFtZSk7XG4gICAgXG4gICAgLy8gQ3JlYXRlIFJEUyBiYWNrdXAgcm9sZVxuICAgIHRoaXMucmRzQmFja3VwUm9sZSA9IHRoaXMuY3JlYXRlUmRzQmFja3VwUm9sZShwcm9qZWN0TmFtZSk7XG5cbiAgICAvLyBBZGQgY29tbW9uIHRhZ3MgdG8gYWxsIHJvbGVzXG4gICAgdGhpcy5hZGRDb21tb25UYWdzKGVudmlyb25tZW50LCBwcm9qZWN0TmFtZSk7XG5cbiAgICAvLyBDcmVhdGUgb3V0cHV0cyBmb3Igcm9sZSBBUk5zXG4gICAgdGhpcy5jcmVhdGVPdXRwdXRzKCk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc1Rhc2tFeGVjdXRpb25Sb2xlKHByb2plY3ROYW1lOiBzdHJpbmcpOiBpYW0uUm9sZSB7XG4gICAgY29uc3Qgcm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWNzVGFza0V4ZWN1dGlvblJvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7cHJvamVjdE5hbWV9LWVjcy10YXNrLWV4ZWN1dGlvbi1yb2xlYCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdlY3MtdGFza3MuYW1hem9uYXdzLmNvbScpLFxuICAgICAgZGVzY3JpcHRpb246ICdFQ1MgVGFzayBFeGVjdXRpb24gUm9sZSBmb3IgQXNzaXN0ZWQgQ0xJTUIgY29udGFpbmVycyB3aXRoIG1pbmltYWwgcGVybWlzc2lvbnMgZm9yIGNvbnRhaW5lciBtYW5hZ2VtZW50J1xuICAgIH0pO1xuXG4gICAgLy8gQWRkIEFXUyBtYW5hZ2VkIHBvbGljeSBmb3IgRUNTIHRhc2sgZXhlY3V0aW9uXG4gICAgcm9sZS5hZGRNYW5hZ2VkUG9saWN5KFxuICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQW1hem9uRUNTVGFza0V4ZWN1dGlvblJvbGVQb2xpY3knKVxuICAgICk7XG5cbiAgICAvLyBBZGQgc3BlY2lmaWMgcGVybWlzc2lvbnMgZm9yIENsb3VkV2F0Y2ggTG9nc1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnbG9nczpDcmVhdGVMb2dHcm91cCcsXG4gICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICdsb2dzOkRlc2NyaWJlTG9nU3RyZWFtcydcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvZWNzLyR7cHJvamVjdE5hbWV9KmAsXG4gICAgICAgIGBhcm46YXdzOmxvZ3M6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmxvZy1ncm91cDovYXdzL2Vjcy8ke3Byb2plY3ROYW1lfSo6KmBcbiAgICAgIF1cbiAgICB9KSk7XG5cbiAgICAvLyBBZGQgcGVybWlzc2lvbnMgZm9yIEVDUiBhY2Nlc3MgKHB1bGxpbmcgY29udGFpbmVyIGltYWdlcylcbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2VjcjpHZXRBdXRob3JpemF0aW9uVG9rZW4nLFxuICAgICAgICAnZWNyOkJhdGNoQ2hlY2tMYXllckF2YWlsYWJpbGl0eScsXG4gICAgICAgICdlY3I6R2V0RG93bmxvYWRVcmxGb3JMYXllcicsXG4gICAgICAgICdlY3I6QmF0Y2hHZXRJbWFnZSdcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFsnKiddIC8vIEVDUiByZXF1aXJlcyB3aWxkY2FyZCBmb3IgR2V0QXV0aG9yaXphdGlvblRva2VuXG4gICAgfSkpO1xuXG4gICAgcmV0dXJuIHJvbGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUVjc1Rhc2tSb2xlKHByb2plY3ROYW1lOiBzdHJpbmcpOiBpYW0uUm9sZSB7XG4gICAgY29uc3Qgcm9sZSA9IG5ldyBpYW0uUm9sZSh0aGlzLCAnRWNzVGFza1JvbGUnLCB7XG4gICAgICByb2xlTmFtZTogYCR7cHJvamVjdE5hbWV9LWVjcy10YXNrLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ0VDUyBUYXNrIFJvbGUgZm9yIGFwcGxpY2F0aW9uIGFjY2VzcyB0byBBV1Mgc2VydmljZXMgKFJEUywgUzMsIFNlY3JldHMgTWFuYWdlciknXG4gICAgfSk7XG5cbiAgICAvLyBTZWNyZXRzIE1hbmFnZXIgYWNjZXNzIGZvciBhcHBsaWNhdGlvbiBjb25maWd1cmF0aW9uXG4gICAgcm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpHZXRTZWNyZXRWYWx1ZScsXG4gICAgICAgICdzZWNyZXRzbWFuYWdlcjpEZXNjcmliZVNlY3JldCdcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6c2VjcmV0c21hbmFnZXI6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlY3JldDoke3Byb2plY3ROYW1lfS8qYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIFMzIGFjY2VzcyBmb3Igc3RhdGljIGFzc2V0cyBhbmQgYmFja3Vwc1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6R2V0T2JqZWN0JyxcbiAgICAgICAgJ3MzOkdldE9iamVjdFZlcnNpb24nLFxuICAgICAgICAnczM6UHV0T2JqZWN0JyxcbiAgICAgICAgJ3MzOkRlbGV0ZU9iamVjdCcsXG4gICAgICAgICdzMzpMaXN0QnVja2V0J1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvamVjdE5hbWV9LXN0YXRpYy1hc3NldHNgLFxuICAgICAgICBgYXJuOmF3czpzMzo6OiR7cHJvamVjdE5hbWV9LXN0YXRpYy1hc3NldHMvKmAsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9qZWN0TmFtZX0tYmFja3Vwc2AsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9qZWN0TmFtZX0tYmFja3Vwcy8qYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIENsb3VkV2F0Y2ggTG9ncyBmb3IgYXBwbGljYXRpb24gbG9nZ2luZ1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnbG9nczpDcmVhdGVMb2dHcm91cCcsXG4gICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cycsXG4gICAgICAgICdsb2dzOkRlc2NyaWJlTG9nR3JvdXBzJyxcbiAgICAgICAgJ2xvZ3M6RGVzY3JpYmVMb2dTdHJlYW1zJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9lY3MvJHtwcm9qZWN0TmFtZX0qYCxcbiAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvZWNzLyR7cHJvamVjdE5hbWV9KjoqYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIExhbWJkYSBpbnZva2UgcGVybWlzc2lvbnMgZm9yIEFJIG9yY2hlc3RyYXRpb25cbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2xhbWJkYTpJbnZva2VGdW5jdGlvbidcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6bGFtYmRhOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpmdW5jdGlvbjoke3Byb2plY3ROYW1lfS1haS0qYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIENsb3VkV2F0Y2ggbWV0cmljcyBmb3IgbW9uaXRvcmluZ1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICdjbG91ZHdhdGNoOm5hbWVzcGFjZSc6IGBBc3Npc3RlZENMSU1CLyR7cHJvamVjdE5hbWV9YFxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSkpO1xuXG4gICAgcmV0dXJuIHJvbGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUxhbWJkYUV4ZWN1dGlvblJvbGUocHJvamVjdE5hbWU6IHN0cmluZyk6IGlhbS5Sb2xlIHtcbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdMYW1iZGFFeGVjdXRpb25Sb2xlJywge1xuICAgICAgcm9sZU5hbWU6IGAke3Byb2plY3ROYW1lfS1sYW1iZGEtZXhlY3V0aW9uLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ0xhbWJkYSBFeGVjdXRpb24gUm9sZSBmb3IgQUkgb3JjaGVzdHJhdGlvbiBmdW5jdGlvbnMgd2l0aCBhY2Nlc3MgdG8gU2VjcmV0cyBNYW5hZ2VyIGFuZCBsb2dnaW5nJ1xuICAgIH0pO1xuXG4gICAgLy8gQWRkIEFXUyBtYW5hZ2VkIHBvbGljeSBmb3IgTGFtYmRhIGJhc2ljIGV4ZWN1dGlvblxuICAgIHJvbGUuYWRkTWFuYWdlZFBvbGljeShcbiAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FXU0xhbWJkYUJhc2ljRXhlY3V0aW9uUm9sZScpXG4gICAgKTtcblxuICAgIC8vIEFkZCBWUEMgZXhlY3V0aW9uIHBvbGljeSBmb3IgTGFtYmRhIGZ1bmN0aW9ucyBpbiBWUENcbiAgICByb2xlLmFkZE1hbmFnZWRQb2xpY3koXG4gICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ3NlcnZpY2Utcm9sZS9BV1NMYW1iZGFWUENBY2Nlc3NFeGVjdXRpb25Sb2xlJylcbiAgICApO1xuXG4gICAgLy8gU2VjcmV0cyBNYW5hZ2VyIGFjY2VzcyBmb3IgQUkgQVBJIGtleXNcbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkdldFNlY3JldFZhbHVlJyxcbiAgICAgICAgJ3NlY3JldHNtYW5hZ2VyOkRlc2NyaWJlU2VjcmV0J1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpzZWNyZXRzbWFuYWdlcjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c2VjcmV0OiR7cHJvamVjdE5hbWV9L2FpLXByb3ZpZGVycy8qYCxcbiAgICAgICAgYGFybjphd3M6c2VjcmV0c21hbmFnZXI6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OnNlY3JldDoke3Byb2plY3ROYW1lfS9nb29nbGUtYWkta2V5KmAsXG4gICAgICAgIGBhcm46YXdzOnNlY3JldHNtYW5hZ2VyOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpzZWNyZXQ6JHtwcm9qZWN0TmFtZX0vYXp1cmUtYWkta2V5KmAsXG4gICAgICAgIGBhcm46YXdzOnNlY3JldHNtYW5hZ2VyOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpzZWNyZXQ6JHtwcm9qZWN0TmFtZX0vYmVkcm9jay1jb25maWcqYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIEFtYXpvbiBCZWRyb2NrIGFjY2VzcyBmb3IgQVdTIG5hdGl2ZSBBSVxuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnYmVkcm9jazpJbnZva2VNb2RlbCcsXG4gICAgICAgICdiZWRyb2NrOkludm9rZU1vZGVsV2l0aFJlc3BvbnNlU3RyZWFtJyxcbiAgICAgICAgJ2JlZHJvY2s6TGlzdEZvdW5kYXRpb25Nb2RlbHMnLFxuICAgICAgICAnYmVkcm9jazpHZXRGb3VuZGF0aW9uTW9kZWwnXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6JHt0aGlzLnJlZ2lvbn06OmZvdW5kYXRpb24tbW9kZWwvYW50aHJvcGljLmNsYXVkZS0zLXNvbm5ldC0qYCxcbiAgICAgICAgYGFybjphd3M6YmVkcm9jazoke3RoaXMucmVnaW9ufTo6Zm91bmRhdGlvbi1tb2RlbC9hbnRocm9waWMuY2xhdWRlLTMtaGFpa3UtKmAsXG4gICAgICAgIGBhcm46YXdzOmJlZHJvY2s6JHt0aGlzLnJlZ2lvbn06OmZvdW5kYXRpb24tbW9kZWwvYW1hem9uLnRpdGFuLSpgXG4gICAgICBdXG4gICAgfSkpO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBMb2dzIGZvciBMYW1iZGEgZnVuY3Rpb24gbG9nZ2luZ1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnbG9nczpDcmVhdGVMb2dHcm91cCcsXG4gICAgICAgICdsb2dzOkNyZWF0ZUxvZ1N0cmVhbScsXG4gICAgICAgICdsb2dzOlB1dExvZ0V2ZW50cydcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFtcbiAgICAgICAgYGFybjphd3M6bG9nczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06bG9nLWdyb3VwOi9hd3MvbGFtYmRhLyR7cHJvamVjdE5hbWV9LSpgLFxuICAgICAgICBgYXJuOmF3czpsb2dzOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTpsb2ctZ3JvdXA6L2F3cy9sYW1iZGEvJHtwcm9qZWN0TmFtZX0tKjoqYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIER5bmFtb0RCIGFjY2VzcyBmb3IgQUkgaW50ZXJhY3Rpb24gYXVkaXQgbG9nZ2luZ1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnZHluYW1vZGI6UHV0SXRlbScsXG4gICAgICAgICdkeW5hbW9kYjpVcGRhdGVJdGVtJyxcbiAgICAgICAgJ2R5bmFtb2RiOkdldEl0ZW0nLFxuICAgICAgICAnZHluYW1vZGI6UXVlcnknLFxuICAgICAgICAnZHluYW1vZGI6QmF0Y2hXcml0ZUl0ZW0nXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOmR5bmFtb2RiOiR7dGhpcy5yZWdpb259OiR7dGhpcy5hY2NvdW50fTp0YWJsZS8ke3Byb2plY3ROYW1lfS1haS1hdWRpdC1sb2dgLFxuICAgICAgICBgYXJuOmF3czpkeW5hbW9kYjoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06dGFibGUvJHtwcm9qZWN0TmFtZX0tYWktYXVkaXQtbG9nL2luZGV4LypgXG4gICAgICBdXG4gICAgfSkpO1xuXG4gICAgLy8gQ2xvdWRXYXRjaCBtZXRyaWNzIGZvciBMYW1iZGEgbW9uaXRvcmluZ1xuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnY2xvdWR3YXRjaDpQdXRNZXRyaWNEYXRhJ1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogWycqJ10sXG4gICAgICBjb25kaXRpb25zOiB7XG4gICAgICAgIFN0cmluZ0VxdWFsczoge1xuICAgICAgICAgICdjbG91ZHdhdGNoOm5hbWVzcGFjZSc6IGBBc3Npc3RlZENMSU1CL0xhbWJkYWBcbiAgICAgICAgfVxuICAgICAgfVxuICAgIH0pKTtcblxuICAgIHJldHVybiByb2xlO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVSZHNNb25pdG9yaW5nUm9sZShwcm9qZWN0TmFtZTogc3RyaW5nKTogaWFtLlJvbGUge1xuICAgIGNvbnN0IHJvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ1Jkc01vbml0b3JpbmdSb2xlJywge1xuICAgICAgcm9sZU5hbWU6IGAke3Byb2plY3ROYW1lfS1yZHMtbW9uaXRvcmluZy1yb2xlYCxcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5TZXJ2aWNlUHJpbmNpcGFsKCdtb25pdG9yaW5nLnJkcy5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ1JEUyBFbmhhbmNlZCBNb25pdG9yaW5nIFJvbGUgZm9yIGRhdGFiYXNlIHBlcmZvcm1hbmNlIG1vbml0b3JpbmcnXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQVdTIG1hbmFnZWQgcG9saWN5IGZvciBSRFMgZW5oYW5jZWQgbW9uaXRvcmluZ1xuICAgIHJvbGUuYWRkTWFuYWdlZFBvbGljeShcbiAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FtYXpvblJEU0VuaGFuY2VkTW9uaXRvcmluZ1JvbGUnKVxuICAgICk7XG5cbiAgICAvLyBBZGRpdGlvbmFsIENsb3VkV2F0Y2ggcGVybWlzc2lvbnMgZm9yIGN1c3RvbSBtZXRyaWNzXG4gICAgcm9sZS5hZGRUb1BvbGljeShuZXcgaWFtLlBvbGljeVN0YXRlbWVudCh7XG4gICAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgICBhY3Rpb25zOiBbXG4gICAgICAgICdjbG91ZHdhdGNoOlB1dE1ldHJpY0RhdGEnLFxuICAgICAgICAnY2xvdWR3YXRjaDpMaXN0TWV0cmljcycsXG4gICAgICAgICdjbG91ZHdhdGNoOkdldE1ldHJpY1N0YXRpc3RpY3MnXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbJyonXSxcbiAgICAgIGNvbmRpdGlvbnM6IHtcbiAgICAgICAgU3RyaW5nRXF1YWxzOiB7XG4gICAgICAgICAgJ2Nsb3Vkd2F0Y2g6bmFtZXNwYWNlJzogW1xuICAgICAgICAgICAgJ0FXUy9SRFMnLFxuICAgICAgICAgICAgYEFzc2lzdGVkQ0xJTUIvRGF0YWJhc2VgXG4gICAgICAgICAgXVxuICAgICAgICB9XG4gICAgICB9XG4gICAgfSkpO1xuXG4gICAgcmV0dXJuIHJvbGU7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZVJkc0JhY2t1cFJvbGUocHJvamVjdE5hbWU6IHN0cmluZyk6IGlhbS5Sb2xlIHtcbiAgICBjb25zdCByb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdSZHNCYWNrdXBSb2xlJywge1xuICAgICAgcm9sZU5hbWU6IGAke3Byb2plY3ROYW1lfS1yZHMtYmFja3VwLXJvbGVgLFxuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2JhY2t1cC5hbWF6b25hd3MuY29tJyksXG4gICAgICBkZXNjcmlwdGlvbjogJ1JEUyBCYWNrdXAgUm9sZSBmb3IgYXV0b21hdGVkIGRhdGFiYXNlIGJhY2t1cHMgYW5kIHBvaW50LWluLXRpbWUgcmVjb3ZlcnknXG4gICAgfSk7XG5cbiAgICAvLyBBZGQgQVdTIG1hbmFnZWQgcG9saWN5IGZvciBBV1MgQmFja3VwIHNlcnZpY2Ugcm9sZVxuICAgIHJvbGUuYWRkTWFuYWdlZFBvbGljeShcbiAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnc2VydmljZS1yb2xlL0FXU0JhY2t1cFNlcnZpY2VSb2xlUG9saWN5Rm9yQmFja3VwJylcbiAgICApO1xuXG4gICAgcm9sZS5hZGRNYW5hZ2VkUG9saWN5KFxuICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQVdTQmFja3VwU2VydmljZVJvbGVQb2xpY3lGb3JSZXN0b3JlcycpXG4gICAgKTtcblxuICAgIC8vIFMzIHBlcm1pc3Npb25zIGZvciBiYWNrdXAgc3RvcmFnZVxuICAgIHJvbGUuYWRkVG9Qb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgYWN0aW9uczogW1xuICAgICAgICAnczM6UHV0T2JqZWN0JyxcbiAgICAgICAgJ3MzOkdldE9iamVjdCcsXG4gICAgICAgICdzMzpEZWxldGVPYmplY3QnLFxuICAgICAgICAnczM6TGlzdEJ1Y2tldCcsXG4gICAgICAgICdzMzpHZXRCdWNrZXRWZXJzaW9uaW5nJyxcbiAgICAgICAgJ3MzOlB1dEJ1Y2tldFZlcnNpb25pbmcnXG4gICAgICBdLFxuICAgICAgcmVzb3VyY2VzOiBbXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9qZWN0TmFtZX0tYmFja3Vwc2AsXG4gICAgICAgIGBhcm46YXdzOnMzOjo6JHtwcm9qZWN0TmFtZX0tYmFja3Vwcy8qYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIC8vIFJEUyBzcGVjaWZpYyBiYWNrdXAgcGVybWlzc2lvbnNcbiAgICByb2xlLmFkZFRvUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ3JkczpDcmVhdGVEQlNuYXBzaG90JyxcbiAgICAgICAgJ3JkczpDcmVhdGVEQkNsdXN0ZXJTbmFwc2hvdCcsXG4gICAgICAgICdyZHM6RGVzY3JpYmVEQlNuYXBzaG90cycsXG4gICAgICAgICdyZHM6RGVzY3JpYmVEQkNsdXN0ZXJTbmFwc2hvdHMnLFxuICAgICAgICAncmRzOkNvcHlEQlNuYXBzaG90JyxcbiAgICAgICAgJ3JkczpDb3B5REJDbHVzdGVyU25hcHNob3QnLFxuICAgICAgICAncmRzOkRlbGV0ZURCU25hcHNob3QnLFxuICAgICAgICAncmRzOkRlbGV0ZURCQ2x1c3RlclNuYXBzaG90J1xuICAgICAgXSxcbiAgICAgIHJlc291cmNlczogW1xuICAgICAgICBgYXJuOmF3czpyZHM6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmRiOiR7cHJvamVjdE5hbWV9LSpgLFxuICAgICAgICBgYXJuOmF3czpyZHM6JHt0aGlzLnJlZ2lvbn06JHt0aGlzLmFjY291bnR9OmNsdXN0ZXI6JHtwcm9qZWN0TmFtZX0tKmAsXG4gICAgICAgIGBhcm46YXdzOnJkczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06c25hcHNob3Q6JHtwcm9qZWN0TmFtZX0tKmAsXG4gICAgICAgIGBhcm46YXdzOnJkczoke3RoaXMucmVnaW9ufToke3RoaXMuYWNjb3VudH06Y2x1c3Rlci1zbmFwc2hvdDoke3Byb2plY3ROYW1lfS0qYFxuICAgICAgXVxuICAgIH0pKTtcblxuICAgIHJldHVybiByb2xlO1xuICB9XG5cbiAgcHJpdmF0ZSBhZGRDb21tb25UYWdzKGVudmlyb25tZW50OiBzdHJpbmcsIHByb2plY3ROYW1lOiBzdHJpbmcpOiB2b2lkIHtcbiAgICBjb25zdCBjb21tb25UYWdzID0ge1xuICAgICAgUHJvamVjdDogJ0Fzc2lzdGVkLUNMSU1CJyxcbiAgICAgIEVudmlyb25tZW50OiBlbnZpcm9ubWVudCxcbiAgICAgIENvbXBvbmVudDogJ0lBTS1Sb2xlcycsXG4gICAgICBDb3N0Q2VudGVyOiAnRWR1Y2F0aW9uLVRlY2hub2xvZ3knLFxuICAgICAgT3duZXI6ICdhc3Npc3RlZC1jbGltYi10ZWFtJyxcbiAgICAgIFB1cnBvc2U6ICdBV1MtTWlncmF0aW9uLVNlY3VyaXR5JyxcbiAgICAgIENvbXBsaWFuY2U6ICdHRFBSLVVLR0RQUidcbiAgICB9O1xuXG4gICAgLy8gQXBwbHkgdGFncyB0byBhbGwgcmVzb3VyY2VzIGluIHRoaXMgc3RhY2tcbiAgICBjZGsuVGFncy5vZih0aGlzKS5hZGQoJ1Byb2plY3QnLCBjb21tb25UYWdzLlByb2plY3QpO1xuICAgIGNkay5UYWdzLm9mKHRoaXMpLmFkZCgnRW52aXJvbm1lbnQnLCBjb21tb25UYWdzLkVudmlyb25tZW50KTtcbiAgICBjZGsuVGFncy5vZih0aGlzKS5hZGQoJ0NvbXBvbmVudCcsIGNvbW1vblRhZ3MuQ29tcG9uZW50KTtcbiAgICBjZGsuVGFncy5vZih0aGlzKS5hZGQoJ0Nvc3RDZW50ZXInLCBjb21tb25UYWdzLkNvc3RDZW50ZXIpO1xuICAgIGNkay5UYWdzLm9mKHRoaXMpLmFkZCgnT3duZXInLCBjb21tb25UYWdzLk93bmVyKTtcbiAgICBjZGsuVGFncy5vZih0aGlzKS5hZGQoJ1B1cnBvc2UnLCBjb21tb25UYWdzLlB1cnBvc2UpO1xuICAgIGNkay5UYWdzLm9mKHRoaXMpLmFkZCgnQ29tcGxpYW5jZScsIGNvbW1vblRhZ3MuQ29tcGxpYW5jZSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU91dHB1dHMoKTogdm9pZCB7XG4gICAgLy8gRUNTIFRhc2sgRXhlY3V0aW9uIFJvbGUgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3NUYXNrRXhlY3V0aW9uUm9sZUFybicsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmVjc1Rhc2tFeGVjdXRpb25Sb2xlLnJvbGVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgRUNTIFRhc2sgRXhlY3V0aW9uIFJvbGUgZm9yIGNvbnRhaW5lciBtYW5hZ2VtZW50JyxcbiAgICAgIGV4cG9ydE5hbWU6ICdBc3Npc3RlZENsaW1iRWNzVGFza0V4ZWN1dGlvblJvbGVBcm4nXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnRWNzVGFza0V4ZWN1dGlvblJvbGVOYW1lJywge1xuICAgICAgdmFsdWU6IHRoaXMuZWNzVGFza0V4ZWN1dGlvblJvbGUucm9sZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ05hbWUgb2YgdGhlIEVDUyBUYXNrIEV4ZWN1dGlvbiBSb2xlJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdBc3Npc3RlZENsaW1iRWNzVGFza0V4ZWN1dGlvblJvbGVOYW1lJ1xuICAgIH0pO1xuXG4gICAgLy8gRUNTIFRhc2sgUm9sZSBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Vjc1Rhc2tSb2xlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMuZWNzVGFza1JvbGUucm9sZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVJOIG9mIHRoZSBFQ1MgVGFzayBSb2xlIGZvciBhcHBsaWNhdGlvbiBBV1Mgc2VydmljZSBhY2Nlc3MnLFxuICAgICAgZXhwb3J0TmFtZTogJ0Fzc2lzdGVkQ2xpbWJFY3NUYXNrUm9sZUFybidcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdFY3NUYXNrUm9sZU5hbWUnLCB7XG4gICAgICB2YWx1ZTogdGhpcy5lY3NUYXNrUm9sZS5yb2xlTmFtZSxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTmFtZSBvZiB0aGUgRUNTIFRhc2sgUm9sZScsXG4gICAgICBleHBvcnROYW1lOiAnQXNzaXN0ZWRDbGltYkVjc1Rhc2tSb2xlTmFtZSdcbiAgICB9KTtcblxuICAgIC8vIExhbWJkYSBFeGVjdXRpb24gUm9sZSBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0xhbWJkYUV4ZWN1dGlvblJvbGVBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5sYW1iZGFFeGVjdXRpb25Sb2xlLnJvbGVBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgTGFtYmRhIEV4ZWN1dGlvbiBSb2xlIGZvciBBSSBvcmNoZXN0cmF0aW9uJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdBc3Npc3RlZENsaW1iTGFtYmRhRXhlY3V0aW9uUm9sZUFybidcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdMYW1iZGFFeGVjdXRpb25Sb2xlTmFtZScsIHtcbiAgICAgIHZhbHVlOiB0aGlzLmxhbWJkYUV4ZWN1dGlvblJvbGUucm9sZU5hbWUsXG4gICAgICBkZXNjcmlwdGlvbjogJ05hbWUgb2YgdGhlIExhbWJkYSBFeGVjdXRpb24gUm9sZScsXG4gICAgICBleHBvcnROYW1lOiAnQXNzaXN0ZWRDbGltYkxhbWJkYUV4ZWN1dGlvblJvbGVOYW1lJ1xuICAgIH0pO1xuXG4gICAgLy8gUkRTIE1vbml0b3JpbmcgUm9sZSBvdXRwdXRzXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ1Jkc01vbml0b3JpbmdSb2xlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucmRzTW9uaXRvcmluZ1JvbGUucm9sZUFybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVJOIG9mIHRoZSBSRFMgTW9uaXRvcmluZyBSb2xlIGZvciBlbmhhbmNlZCBtb25pdG9yaW5nJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdBc3Npc3RlZENsaW1iUmRzTW9uaXRvcmluZ1JvbGVBcm4nXG4gICAgfSk7XG5cbiAgICAvLyBSRFMgQmFja3VwIFJvbGUgb3V0cHV0c1xuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdSZHNCYWNrdXBSb2xlQXJuJywge1xuICAgICAgdmFsdWU6IHRoaXMucmRzQmFja3VwUm9sZS5yb2xlQXJuLFxuICAgICAgZGVzY3JpcHRpb246ICdBUk4gb2YgdGhlIFJEUyBCYWNrdXAgUm9sZSBmb3IgYXV0b21hdGVkIGJhY2t1cHMnLFxuICAgICAgZXhwb3J0TmFtZTogJ0Fzc2lzdGVkQ2xpbWJSZHNCYWNrdXBSb2xlQXJuJ1xuICAgIH0pO1xuXG4gICAgLy8gU3VtbWFyeSBvdXRwdXQgd2l0aCBhbGwgcm9sZSBpbmZvcm1hdGlvblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdJYW1Sb2xlc1N1bW1hcnknLCB7XG4gICAgICB2YWx1ZTogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICBlY3NUYXNrRXhlY3V0aW9uUm9sZTogdGhpcy5lY3NUYXNrRXhlY3V0aW9uUm9sZS5yb2xlTmFtZSxcbiAgICAgICAgZWNzVGFza1JvbGU6IHRoaXMuZWNzVGFza1JvbGUucm9sZU5hbWUsXG4gICAgICAgIGxhbWJkYUV4ZWN1dGlvblJvbGU6IHRoaXMubGFtYmRhRXhlY3V0aW9uUm9sZS5yb2xlTmFtZSxcbiAgICAgICAgcmRzTW9uaXRvcmluZ1JvbGU6IHRoaXMucmRzTW9uaXRvcmluZ1JvbGUucm9sZU5hbWUsXG4gICAgICAgIHJkc0JhY2t1cFJvbGU6IHRoaXMucmRzQmFja3VwUm9sZS5yb2xlTmFtZVxuICAgICAgfSksXG4gICAgICBkZXNjcmlwdGlvbjogJ0pTT04gc3VtbWFyeSBvZiBhbGwgY3JlYXRlZCBJQU0gcm9sZXMgZm9yIHJlZmVyZW5jZSdcbiAgICB9KTtcbiAgfVxufSJdfQ==