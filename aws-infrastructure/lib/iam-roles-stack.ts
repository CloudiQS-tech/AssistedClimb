import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface IamRolesStackProps extends cdk.StackProps {
  /**
   * Environment name for resource tagging
   * @default 'development'
   */
  environment?: string;
  
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
}

export class IamRolesStack extends cdk.Stack {
  public readonly ecsTaskExecutionRole: iam.Role;
  public readonly ecsTaskRole: iam.Role;
  public readonly lambdaExecutionRole: iam.Role;
  public readonly rdsMonitoringRole: iam.Role;
  public readonly rdsBackupRole: iam.Role;

  constructor(scope: Construct, id: string, props: IamRolesStackProps = {}) {
    super(scope, id, props);

    const {
      environment = 'development',
      projectName = 'assisted-climb'
    } = props;

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

  private createEcsTaskExecutionRole(projectName: string): iam.Role {
    const role = new iam.Role(this, 'EcsTaskExecutionRole', {
      roleName: `${projectName}-ecs-task-execution-role`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'ECS Task Execution Role for Assisted CLIMB containers with minimal permissions for container management'
    });

    // Add AWS managed policy for ECS task execution
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );

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

  private createEcsTaskRole(projectName: string): iam.Role {
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

  private createLambdaExecutionRole(projectName: string): iam.Role {
    const role = new iam.Role(this, 'LambdaExecutionRole', {
      roleName: `${projectName}-lambda-execution-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Lambda Execution Role for AI orchestration functions with access to Secrets Manager and logging'
    });

    // Add AWS managed policy for Lambda basic execution
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
    );

    // Add VPC execution policy for Lambda functions in VPC
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole')
    );

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

  private createRdsMonitoringRole(projectName: string): iam.Role {
    const role = new iam.Role(this, 'RdsMonitoringRole', {
      roleName: `${projectName}-rds-monitoring-role`,
      assumedBy: new iam.ServicePrincipal('monitoring.rds.amazonaws.com'),
      description: 'RDS Enhanced Monitoring Role for database performance monitoring'
    });

    // Add AWS managed policy for RDS enhanced monitoring
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonRDSEnhancedMonitoringRole')
    );

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

  private createRdsBackupRole(projectName: string): iam.Role {
    const role = new iam.Role(this, 'RdsBackupRole', {
      roleName: `${projectName}-rds-backup-role`,
      assumedBy: new iam.ServicePrincipal('backup.amazonaws.com'),
      description: 'RDS Backup Role for automated database backups and point-in-time recovery'
    });

    // Add AWS managed policy for AWS Backup service role
    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForBackup')
    );

    role.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSBackupServiceRolePolicyForRestores')
    );

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

  private addCommonTags(environment: string, projectName: string): void {
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

  private createOutputs(): void {
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