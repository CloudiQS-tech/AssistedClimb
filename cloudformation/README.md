# Assisted CLIMB AWS CloudFormation Infrastructure

This directory contains the complete AWS infrastructure setup for the Assisted CLIMB educational platform using CloudFormation templates.

## 🏗️ Architecture Overview

The infrastructure follows a 7-phase deployment approach optimized for cost (<$100/month) and security:

1. **Billing & Cost Monitoring** (us-east-1)
2. **VPC & Network Infrastructure** 
3. **IAM Roles & Security**
4. **RDS PostgreSQL Database**
5. **ECS Fargate Cluster & Load Balancer**
6. **S3 Storage & CloudFront CDN**
7. **Lambda AI Functions**

## 📁 Template Files

| Template | Description | Dependencies |
|----------|-------------|--------------|
| `01-billing-alerts.yaml` | Billing alarms, budgets, cost monitoring | None |
| `02-vpc-network.yaml` | VPC, subnets, security groups, endpoints | None |
| `03-iam-roles.yaml` | IAM roles for ECS, Lambda, RDS | None |
| `04-rds-database.yaml` | PostgreSQL database with backups | VPC, IAM |
| `05-ecs-cluster.yaml` | ECS Fargate cluster and ALB | VPC, IAM |
| `06-s3-cloudfront.yaml` | S3 buckets and CloudFront CDN | ECS (for OAC) |
| `07-lambda-ai.yaml` | AI integration Lambda functions | VPC, IAM |

## 🚀 Quick Deployment

### Prerequisites

1. **AWS CLI** installed and configured
2. **Administrative AWS permissions**
3. **Domain access** (optional, for custom domain)
4. **Email access** for billing alerts

### One-Command Deployment

```bash
cd cloudformation
./deploy.sh
```

### Manual Step-by-Step Deployment

```bash
# 1. Billing alerts (deploy to us-east-1)
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-Billing-Alerts \
  --template-body file://01-billing-alerts.yaml \
  --parameters ParameterKey=AlertEmail,ParameterValue=admin@assistedclimb.education \
  --region us-east-1 \
  --capabilities CAPABILITY_NAMED_IAM

# 2. VPC and network (deploy to eu-west-2)  
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-VPC-Network \
  --template-body file://02-vpc-network.yaml \
  --region eu-west-2

# 3. IAM roles
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-IAM-Roles \
  --template-body file://03-iam-roles.yaml \
  --region eu-west-2 \
  --capabilities CAPABILITY_NAMED_IAM

# 4. RDS database
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-RDS-Database \
  --template-body file://04-rds-database.yaml \
  --parameters ParameterKey=DBInstanceClass,ParameterValue=db.t3.small \
  --region eu-west-2

# 5. ECS cluster
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-ECS-Cluster \
  --template-body file://05-ecs-cluster.yaml \
  --parameters ParameterKey=DesiredCount,ParameterValue=1 \
  --region eu-west-2

# 6. S3 and CloudFront
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-S3-CloudFront \
  --template-body file://06-s3-cloudfront.yaml \
  --parameters ParameterKey=DomainName,ParameterValue=assistedclimb.education \
  --region eu-west-2

# 7. Lambda AI functions
aws cloudformation create-stack \
  --stack-name Assisted-CLIMB-Lambda-AI \
  --template-body file://07-lambda-ai.yaml \
  --region eu-west-2
```

## ⚙️ Configuration Parameters

### Key Parameters to Customize

Edit these in `deploy.sh` or pass as parameters:

```bash
# Project Configuration
PROJECT_NAME="Assisted-CLIMB"
REGION="eu-west-2"               # London region
ALERT_EMAIL="admin@assistedclimb.education"
DOMAIN_NAME="assistedclimb.education"
MONTHLY_BUDGET_LIMIT=100

# Database Configuration  
DB_INSTANCE_CLASS="db.t3.small"  # Cost-optimized
MULTI_AZ="false"                 # Single-AZ for cost savings
BACKUP_RETENTION_DAYS=7

# ECS Configuration
DESIRED_TASK_COUNT=1             # Start with 1 task
FRONTEND_CPU=256                 # 0.25 vCPU
FRONTEND_MEMORY=512              # 512MB RAM
BACKEND_CPU=512                  # 0.5 vCPU  
BACKEND_MEMORY=1024              # 1GB RAM
```

## 💰 Cost Optimization Features

### Built-in Cost Controls
- **Billing Alerts**: $50, $80, $100, $120 thresholds
- **AWS Budgets**: Monthly, forecasted, and usage budgets
- **Cost Anomaly Detection**: ML-powered spending alerts
- **VPC Endpoints**: Avoids NAT Gateway costs ($45/month savings)
- **Single-AZ RDS**: Cost-optimized database deployment
- **Intelligent Tiering**: Automatic S3 storage optimization

### Estimated Monthly Costs
| Service | Configuration | Monthly Cost |
|---------|---------------|--------------|
| ECS Fargate | 1 task, 0.75 vCPU, 1.5GB | ~$25 |
| RDS PostgreSQL | db.t3.small, Single-AZ | ~$15 |
| CloudFront | Global CDN | ~$5 |
| Lambda | AI functions | ~$2 |
| S3 + Other | Storage, networking | ~$3 |
| **Total** | | **~$50/month** |

## 🔒 Security Features

### Data Protection
- **Encryption at Rest**: All S3, RDS, Secrets Manager
- **Encryption in Transit**: TLS 1.3 for all connections
- **VPC Isolation**: Private subnets for application components
- **Security Groups**: Minimal required access rules

### Access Control
- **IAM Least Privilege**: Service-specific roles and policies
- **Secrets Manager**: Encrypted storage for API keys and credentials
- **WAF Protection**: CloudFront Web ACL with common attack rules
- **Multi-tenant Isolation**: Row-level security in PostgreSQL

### Audit & Compliance
- **CloudTrail Logging**: All API calls tracked
- **VPC Flow Logs**: Network traffic monitoring
- **Container Insights**: ECS task and service monitoring
- **Cost Allocation Tags**: Resource tracking and governance

## 🏥 High Availability & Backup

### Backup Strategy
- **RDS Automated Backups**: 7-day retention with point-in-time recovery
- **S3 Versioning**: Asset version control and protection
- **Multi-AZ ALB**: Load balancer across availability zones
- **ECS Service Resilience**: Automatic task replacement

### Monitoring & Alerting
- **CloudWatch Dashboards**: Real-time application metrics
- **CloudWatch Alarms**: CPU, memory, error rate, database performance
- **SNS Notifications**: Email alerts for critical events
- **Log Aggregation**: Centralized logging for troubleshooting

## 📋 Post-Deployment Steps

### 1. Configure AI API Keys

```bash
# Update Google AI secret
aws secretsmanager put-secret-value \
  --secret-id assisted-climb/ai-keys/google \
  --secret-string '{"default_api_key":"YOUR_GOOGLE_API_KEY","organizations":{}}'

# Update Microsoft AI secret  
aws secretsmanager put-secret-value \
  --secret-id assisted-climb/ai-keys/microsoft \
  --secret-string '{"default_api_key":"YOUR_MICROSOFT_API_KEY","default_endpoint":"YOUR_AZURE_ENDPOINT","organizations":{}}'
```

### 2. Build and Deploy Container Images

```bash
# Create ECR repositories
aws ecr create-repository --repository-name assisted-climb/frontend
aws ecr create-repository --repository-name assisted-climb/backend

# Build and push images (run from your source code directory)
# Frontend
docker build -t assisted-climb-frontend ./artifacts/assisted-climb
docker tag assisted-climb-frontend:latest 123456789.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb/frontend:latest
docker push 123456789.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb/frontend:latest

# Backend  
docker build -t assisted-climb-backend ./artifacts/api-server
docker tag assisted-climb-backend:latest 123456789.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb/backend:latest
docker push 123456789.dkr.ecr.eu-west-2.amazonaws.com/assisted-climb/backend:latest

# Update ECS task definitions with new image URIs
aws ecs update-service --cluster Assisted-CLIMB-cluster --service Assisted-CLIMB-frontend-service --force-new-deployment
aws ecs update-service --cluster Assisted-CLIMB-cluster --service Assisted-CLIMB-backend-service --force-new-deployment
```

### 3. Database Migration

```bash
# Get database endpoint
DB_ENDPOINT=$(aws cloudformation describe-stacks --stack-name Assisted-CLIMB-RDS-Database --query 'Stacks[0].Outputs[?OutputKey==`DatabaseEndpoint`].OutputValue' --output text)

# Run database migration (from your migration scripts)
psql -h $DB_ENDPOINT -U postgres -d assisted_climb -f migration_scripts/schema.sql
psql -h $DB_ENDPOINT -U postgres -d assisted_climb -f migration_scripts/data_import.sql
```

### 4. Custom Domain Setup (Optional)

If you enabled SSL certificate creation, update your domain's nameservers:

```bash
# Get hosted zone name servers
aws route53 get-hosted-zone --id $(aws cloudformation describe-stacks --stack-name Assisted-CLIMB-S3-CloudFront --query 'Stacks[0].Outputs[?OutputKey==`HostedZoneId`].OutputValue' --output text)

# Update domain registrar to use AWS nameservers
```

### 5. Application Testing

```bash
# Get application URLs
ALB_URL=$(aws cloudformation describe-stacks --stack-name Assisted-CLIMB-ECS-Cluster --query 'Stacks[0].Outputs[?OutputKey==`ALBDNSName`].OutputValue' --output text)
APP_URL=$(aws cloudformation describe-stacks --stack-name Assisted-CLIMB-S3-CloudFront --query 'Stacks[0].Outputs[?OutputKey==`AppURL`].OutputValue' --output text)

# Test endpoints
curl -f http://$ALB_URL/health
curl -f $APP_URL
```

## 🔧 Troubleshooting

### Common Issues

1. **Stack Creation Fails**
   ```bash
   # Check stack events for detailed error information
   aws cloudformation describe-stack-events --stack-name STACK_NAME
   ```

2. **Database Connection Issues**
   ```bash
   # Verify security groups allow ECS to RDS communication
   aws ec2 describe-security-groups --group-ids sg-xxxxxxxxx
   ```

3. **ECS Tasks Not Starting**
   ```bash
   # Check ECS service events and task logs
   aws ecs describe-services --cluster CLUSTER_NAME --services SERVICE_NAME
   aws logs tail /ecs/assisted-climb/backend --follow
   ```

4. **High AWS Costs**
   ```bash
   # Check cost breakdown by service
   aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-01-31 --granularity MONTHLY --metrics BlendedCost --group-by Type=DIMENSION,Key=SERVICE
   ```

### Support Commands

```bash
# Validate all templates
find . -name "*.yaml" -exec aws cloudformation validate-template --template-body file://{} \;

# Get all stack outputs
for stack in Assisted-CLIMB-*; do
  echo "=== $stack ==="
  aws cloudformation describe-stacks --stack-name $stack --query 'Stacks[0].Outputs'
done

# Monitor deployment progress
aws cloudformation describe-stack-events --stack-name STACK_NAME --output table

# Check resource costs
aws ce get-cost-and-usage --time-period Start=$(date -d "1 month ago" +%Y-%m-%d),End=$(date +%Y-%m-%d) --granularity MONTHLY --metrics BlendedCost
```

## 🗑️ Cleanup

To delete all infrastructure:

```bash
./deploy.sh cleanup
```

Or manually delete stacks in reverse order:
```bash
aws cloudformation delete-stack --stack-name Assisted-CLIMB-Lambda-AI
aws cloudformation delete-stack --stack-name Assisted-CLIMB-S3-CloudFront  
aws cloudformation delete-stack --stack-name Assisted-CLIMB-ECS-Cluster
aws cloudformation delete-stack --stack-name Assisted-CLIMB-RDS-Database
aws cloudformation delete-stack --stack-name Assisted-CLIMB-IAM-Roles
aws cloudformation delete-stack --stack-name Assisted-CLIMB-VPC-Network
aws cloudformation delete-stack --stack-name Assisted-CLIMB-Billing-Alerts
```

## 📞 Support

For deployment issues:
1. Check the troubleshooting section above
2. Review CloudFormation stack events for detailed error messages
3. Verify all prerequisites are met
4. Check AWS service limits in your account

## 🏷️ Tags

All resources are tagged for cost tracking and governance:
- **Project**: Assisted-CLIMB  
- **Environment**: Production
- **ManagedBy**: CloudFormation
- **CostCenter**: Education-Platform

---

**Cost Target**: <$100/month | **Security**: Enterprise-grade | **Availability**: 99.5%+ uptime