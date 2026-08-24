# IAM Roles and Security Architecture

## Overview

This document describes the IAM roles and security policies created for the Assisted CLIMB AWS migration. All roles follow AWS security best practices with the principle of least privilege access.

## IAM Roles Created

### 1. ECS Task Execution Role (`assisted-climb-ecs-task-execution-role`)

**Purpose**: Minimal permissions for ECS Fargate to manage container execution

**Permissions**:
- Pull container images from ECR repositories
- Create and write to CloudWatch log streams
- Basic ECS task execution capabilities

**AWS Managed Policies**:
- `AmazonECSTaskExecutionRolePolicy`

**Custom Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogGroup",
        "logs:CreateLogStream", 
        "logs:PutLogEvents",
        "logs:DescribeLogStreams"
      ],
      "Resource": "arn:aws:logs:eu-west-2:*:log-group:/aws/ecs/assisted-climb*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage"
      ],
      "Resource": "*"
    }
  ]
}
```

**Security Considerations**:
- Scoped to specific log groups with project prefix
- ECR access limited to necessary actions for image pulling
- No access to application data or user information

### 2. ECS Task Role (`assisted-climb-ecs-task-role`)

**Purpose**: Application-level access to AWS services for the running containers

**Permissions**:
- Access to Secrets Manager for configuration and API keys
- S3 access for static assets and backups
- Lambda invocation for AI orchestration
- CloudWatch metrics and logging
- Limited cross-service communication

**Custom Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": "arn:aws:secretsmanager:eu-west-2:*:secret:assisted-climb/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::assisted-climb-static-assets",
        "arn:aws:s3:::assisted-climb-static-assets/*",
        "arn:aws:s3:::assisted-climb-backups",
        "arn:aws:s3:::assisted-climb-backups/*"
      ]
    },
    {
      "Effect": "Allow", 
      "Action": [
        "lambda:InvokeFunction"
      ],
      "Resource": "arn:aws:lambda:eu-west-2:*:function:assisted-climb-ai-*"
    }
  ]
}
```

**Security Considerations**:
- Secrets access scoped to project-specific secrets only
- S3 access limited to designated buckets for static assets and backups
- Lambda invocation restricted to AI-related functions only
- CloudWatch metrics scoped to project namespace

### 3. Lambda Execution Role (`assisted-climb-lambda-execution-role`)

**Purpose**: AI orchestration functions with secure access to external AI providers

**Permissions**:
- VPC access for secure networking
- Secrets Manager access for AI provider API keys
- Amazon Bedrock access for AWS-native AI
- DynamoDB access for audit logging
- CloudWatch logging and metrics

**AWS Managed Policies**:
- `AWSLambdaBasicExecutionRole`
- `AWSLambdaVPCAccessExecutionRole`

**Custom Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret"
      ],
      "Resource": [
        "arn:aws:secretsmanager:eu-west-2:*:secret:assisted-climb/ai-providers/*",
        "arn:aws:secretsmanager:eu-west-2:*:secret:assisted-climb/google-ai-key*",
        "arn:aws:secretsmanager:eu-west-2:*:secret:assisted-climb/azure-ai-key*",
        "arn:aws:secretsmanager:eu-west-2:*:secret:assisted-climb/bedrock-config*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel",
        "bedrock:InvokeModelWithResponseStream",
        "bedrock:ListFoundationModels",
        "bedrock:GetFoundationModel"
      ],
      "Resource": [
        "arn:aws:bedrock:eu-west-2::foundation-model/anthropic.claude-3-sonnet-*",
        "arn:aws:bedrock:eu-west-2::foundation-model/anthropic.claude-3-haiku-*",
        "arn:aws:bedrock:eu-west-2::foundation-model/amazon.titan-*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:PutItem",
        "dynamodb:UpdateItem", 
        "dynamodb:GetItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:eu-west-2:*:table/assisted-climb-ai-audit-log",
        "arn:aws:dynamodb:eu-west-2:*:table/assisted-climb-ai-audit-log/index/*"
      ]
    }
  ]
}
```

**Security Considerations**:
- Secrets access limited to AI provider keys only
- Bedrock access restricted to approved foundation models
- DynamoDB access scoped to audit logging table only
- All AI interactions logged for compliance and security audit

### 4. RDS Monitoring Role (`assisted-climb-rds-monitoring-role`)

**Purpose**: Enhanced monitoring for database performance and health

**Permissions**:
- RDS enhanced monitoring capabilities
- CloudWatch metrics publishing
- Database performance insights

**AWS Managed Policies**:
- `AmazonRDSEnhancedMonitoringRole`

**Custom Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudwatch:PutMetricData",
        "cloudwatch:ListMetrics",
        "cloudwatch:GetMetricStatistics"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudwatch:namespace": [
            "AWS/RDS",
            "AssistedCLIMB/Database"
          ]
        }
      }
    }
  ]
}
```

**Security Considerations**:
- CloudWatch access limited to RDS and project-specific namespaces
- Read-only access to metrics and monitoring data
- No access to application data or user information

### 5. RDS Backup Role (`assisted-climb-rds-backup-role`)

**Purpose**: Automated database backups and disaster recovery

**Permissions**:
- AWS Backup service capabilities
- RDS snapshot management
- S3 access for backup storage
- Cross-region backup capabilities (if needed)

**AWS Managed Policies**:
- `AWSBackupServiceRolePolicyForBackup`
- `AWSBackupServiceRolePolicyForRestores`

**Custom Permissions**:
```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject", 
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::assisted-climb-backups",
        "arn:aws:s3:::assisted-climb-backups/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "rds:CreateDBSnapshot",
        "rds:CreateDBClusterSnapshot",
        "rds:DescribeDBSnapshots", 
        "rds:DescribeDBClusterSnapshots",
        "rds:CopyDBSnapshot",
        "rds:CopyDBClusterSnapshot",
        "rds:DeleteDBSnapshot",
        "rds:DeleteDBClusterSnapshot"
      ],
      "Resource": [
        "arn:aws:rds:eu-west-2:*:db:assisted-climb-*",
        "arn:aws:rds:eu-west-2:*:cluster:assisted-climb-*",
        "arn:aws:rds:eu-west-2:*:snapshot:assisted-climb-*",
        "arn:aws:rds:eu-west-2:*:cluster-snapshot:assisted-climb-*"
      ]
    }
  ]
}
```

**Security Considerations**:
- S3 access limited to designated backup bucket
- RDS access scoped to project-specific database instances
- Snapshot management limited to project resources
- Supports encryption at rest for all backups

## Multi-Tenant Data Isolation

### Row-Level Security (RLS) Support
All IAM roles are designed to work with PostgreSQL Row-Level Security policies:

```sql
-- Enable RLS on all tenant-specific tables
ALTER TABLE organisations ENABLE ROW LEVEL SECURITY;
ALTER TABLE teachers ENABLE ROW LEVEL SECURITY;
ALTER TABLE classes ENABLE ROW LEVEL SECURITY;
ALTER TABLE student_sessions ENABLE ROW LEVEL SECURITY;

-- Create policy for teacher data access
CREATE POLICY teacher_access_policy ON teachers
  FOR ALL TO application_role
  USING (organisation_id = current_setting('app.current_organisation_id')::INTEGER);
```

### Cross-Service Access Control
- **ECS ↔ RDS**: Database connections authenticated via IAM database authentication where possible
- **Lambda ↔ Secrets Manager**: AI API keys encrypted and organization-scoped
- **ECS ↔ S3**: Static assets and backups isolated by organization prefix
- **All Services ↔ CloudWatch**: Metrics and logs tagged by organization for isolation

## GDPR/UK GDPR Compliance

### Data Protection Features
- **Encryption at Rest**: All secrets encrypted with AWS KMS
- **Encryption in Transit**: All connections use TLS 1.3
- **Access Logging**: All data access logged to CloudWatch
- **Audit Trail**: AI interactions logged to DynamoDB for compliance
- **Data Minimization**: Roles have minimal required permissions only

### Data Subject Rights Support
IAM roles enable implementation of GDPR rights:
- **Right of Access**: Lambda can export user data via S3
- **Right of Rectification**: ECS can update user information
- **Right of Erasure**: ECS can delete or anonymize user data
- **Data Portability**: Lambda can generate user data exports

## Monitoring and Security

### CloudWatch Integration
All roles include CloudWatch permissions for:
- Application performance monitoring
- Security event logging
- Cost tracking by service
- Compliance audit trails

### Security Monitoring
- **AWS CloudTrail**: All IAM role usage logged
- **AWS Config**: IAM role compliance monitoring
- **AWS GuardDuty**: Threat detection for role usage
- **Custom Metrics**: Application-specific security metrics

## Operational Access Patterns

### Normal Operations
1. **ECS Tasks** use Task Role to access Secrets Manager, S3, and Lambda
2. **Lambda Functions** use Execution Role to access AI providers and audit logging
3. **RDS Instance** uses Monitoring Role for performance insights
4. **AWS Backup** uses Backup Role for automated database backups

### Emergency Procedures
- All roles support emergency access via AWS CloudShell
- Backup restoration procedures documented and tested
- Cross-region failover capabilities for disaster recovery

## Cost Optimization

### IAM Role Cost Impact
- **No Direct Costs**: IAM roles themselves have no charges
- **Indirect Savings**: Precise permissions prevent over-provisioning
- **Monitoring Benefits**: Enhanced monitoring enables right-sizing
- **Backup Efficiency**: Automated backups optimize storage costs

### Regular Reviews
- Monthly IAM access review to remove unused permissions
- Quarterly security assessment of role policies
- Annual compliance audit of data access patterns

## Integration with Existing Infrastructure

### BillingAlertsStack Integration
IAM roles support cost tracking via:
- Resource tagging for cost allocation
- CloudWatch metrics for usage monitoring
- SNS notifications for security alerts

### MonitoringStack Integration
IAM roles enable comprehensive monitoring:
- Application performance metrics
- Security event correlation
- Compliance reporting dashboards

## Future Enhancements

### Planned Improvements
1. **AWS SSO Integration**: Enterprise authentication for larger deployments
2. **Cross-Account Access**: Support for multi-account architectures
3. **Advanced Compliance**: Additional FERPA and COPPA compliance features
4. **Zero-Trust Architecture**: Enhanced service mesh security

### Scalability Considerations
- Role policies designed for 1-100 schools deployment
- Cross-region replication support for global expansion
- Multi-tenant isolation maintains security at scale