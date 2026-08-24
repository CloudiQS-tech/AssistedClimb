# Assisted CLIMB AWS Infrastructure

This repository contains the Infrastructure as Code (IaC) for the Assisted CLIMB educational platform migration to AWS. The infrastructure is built using AWS CDK (Cloud Development Kit) with TypeScript.

## Overview

The infrastructure is designed to support the migration of the Assisted CLIMB platform from Replit to AWS with a target monthly cost of <$100 for pilot deployment across 1-10 schools.

## Architecture

### Cost Optimization Features
- **Billing Alerts**: Automated alerts at $50 and $100 thresholds
- **Budget Monitoring**: Monthly budgets with forecasting
- **Cost Anomaly Detection**: Automated detection of unusual spending patterns
- **Resource Optimization**: Right-sized resources and reserved instances

### Security Features
- **VPC Isolation**: Private subnets for application components
- **Encryption**: All data encrypted at rest and in transit
- **IAM Best Practices**: Least privilege access controls
- **Secrets Management**: AWS Secrets Manager for API keys and credentials

## Stacks

### 1. BillingAlertsStack
Located in `us-east-1` (required for billing metrics):
- CloudWatch billing alarms at $50 and $100
- AWS Budgets for comprehensive cost tracking
- SNS notifications for billing alerts
- Cost anomaly detection

**Key Features:**
- **Billing Alarms**: Real-time alerts when costs exceed thresholds
- **Budget Tracking**: Monthly, forecasted, and usage-based budgets  
- **Anomaly Detection**: ML-powered detection of unusual spending
- **Multi-threshold Alerts**: 50%, 80%, 100%, and 120% budget alerts

### 2. MonitoringStack  
Located in `eu-west-2` (application region):
- CloudWatch dashboards for cost and operational monitoring
- Cost Explorer configuration
- Operational alerting infrastructure

**Key Features:**
- **Cost Dashboard**: Visual tracking of spend by service
- **Budget Visualization**: Real-time budget utilization
- **Cost Optimization Guidance**: Built-in recommendations
- **Operational Readiness**: Framework for application metrics

## Prerequisites

1. **AWS Account**: Admin access to AWS account
2. **AWS CLI**: Configured with appropriate credentials
3. **Node.js**: Version 18 or later
4. **AWS CDK**: Version 2.95.1 or later

## Installation

1. Clone this repository:
   ```bash
   git clone <repository-url>
   cd aws-infrastructure
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Bootstrap CDK (first time only):
   ```bash
   npx cdk bootstrap aws://ACCOUNT-NUMBER/us-east-1
   npx cdk bootstrap aws://ACCOUNT-NUMBER/eu-west-2
   ```

## Deployment

### 1. Configure Environment Variables

```bash
export CDK_DEFAULT_ACCOUNT=123456789012
export ALERT_EMAIL=admin@assistedclimb.education
```

### 2. Deploy Billing Alerts (Critical - Deploy First)

```bash
# Deploy to us-east-1 for billing metrics
npx cdk deploy AssistedClimbBillingAlertsStack
```

### 3. Deploy Monitoring Infrastructure

```bash
# Deploy to eu-west-2 for operational monitoring
npx cdk deploy AssistedClimbMonitoringStack
```

### 4. Verify Deployment

After deployment, verify:

1. **SNS Subscriptions**: Check email for subscription confirmation
2. **CloudWatch Dashboards**: Visit AWS Console to view dashboards
3. **Budget Configuration**: Confirm budgets in AWS Billing console
4. **Cost Explorer**: Verify Cost Explorer is enabled

## Cost Monitoring

### Alert Thresholds
- **$50 (50% budget)**: Early warning alert
- **$100 (100% budget)**: Budget limit reached  
- **$120 (120% budget)**: Critical overspend alert

### Budget Categories
1. **Monthly Cost Budget**: $100 total monthly spend
2. **Forecasted Budget**: Predictive alerts at 80% forecast
3. **Usage Budget**: Compute hours for ECS/RDS services

### Cost Optimization Features
- **Reserved Instances**: Recommendations for RDS and EC2
- **Right Sizing**: Monitoring for over-provisioned resources
- **VPC Endpoints**: Elimination of NAT Gateway costs
- **S3 Intelligent Tiering**: Automatic storage cost optimization

## Monitoring Dashboards

### Cost Dashboard
- Real-time billing metrics
- Service-specific cost breakdown
- Budget utilization tracking
- Cost optimization recommendations

### Operations Dashboard (Future)
Will include metrics for:
- ECS service health and performance
- RDS database performance
- ALB request patterns and errors
- Lambda function performance
- CloudFront cache performance

## Security Configuration

### IAM Roles and Policies
- **Least Privilege**: Minimal required permissions
- **Service-Specific Roles**: Separate roles for each AWS service
- **Cross-Account Protection**: Restricted to account resources

### Encryption
- **At Rest**: All storage encrypted with AWS managed keys
- **In Transit**: TLS 1.3 for all communications
- **Secrets**: AWS Secrets Manager for API keys and credentials

### Network Security
- **VPC Isolation**: Private subnets for application components
- **Security Groups**: Restrictive ingress/egress rules
- **NACLs**: Additional network-level security

## Troubleshooting

### Common Issues

1. **Billing Metrics Not Appearing**
   - Ensure deployment is in `us-east-1` region
   - Wait 24 hours for first billing metrics
   - Verify CloudWatch billing service is enabled

2. **SNS Subscription Not Confirmed**
   - Check spam folder for confirmation email
   - Manually confirm subscription in AWS Console
   - Verify email address is correct

3. **Cost Explorer Not Available**
   - Enable Cost Explorer in AWS Billing console
   - Wait up to 24 hours for data population
   - Ensure account has billing permissions

4. **Budget Alerts Not Firing**
   - Verify budget configuration includes correct filters
   - Check SNS topic permissions
   - Confirm threshold percentages are correct

### Support Commands

```bash
# Check stack status
npx cdk list
npx cdk diff

# View stack outputs
aws cloudformation describe-stacks --stack-name assisted-climb-billing-alerts
aws cloudformation describe-stacks --stack-name assisted-climb-monitoring

# Test SNS notifications
aws sns publish --topic-arn <TOPIC-ARN> --message "Test notification"
```

## Next Steps

After successful deployment of billing and monitoring infrastructure:

1. **Verify Cost Tracking**: Monitor for 48 hours to ensure alerts work
2. **Deploy VPC Infrastructure**: Proceed to network setup (Task 1.3)
3. **Configure Application Infrastructure**: ECS, RDS, and Lambda setup
4. **Update Monitoring**: Add application-specific metrics and alerts

## Cost Estimates

### Pilot Phase (1-10 schools, ~500 users)
- **ECS Fargate**: ~$25/month (2 tasks, 0.25 vCPU, 0.5GB RAM)
- **RDS PostgreSQL**: ~$15/month (db.t3.small, Single-AZ)
- **CloudFront**: ~$5/month (typical education usage)
- **Lambda**: ~$2/month (AI integration functions)
- **Other Services**: ~$3/month (S3, Secrets Manager, etc.)
- **Total Estimated**: ~$50/month (well under $100 budget)

### Production Phase (50+ schools, 5000+ users)
- **ECS Fargate**: ~$125/month (auto-scaling, Multi-AZ)
- **RDS PostgreSQL**: ~$75/month (db.t3.medium, Multi-AZ, Reserved)
- **CloudFront**: ~$25/month (global distribution)
- **Lambda**: ~$10/month (higher AI usage)
- **Other Services**: ~$15/month
- **Total Estimated**: ~$250/month (~$5/school/month for 50 schools)

## Tags

All resources are tagged with:
- **Project**: Assisted-CLIMB
- **Environment**: Production
- **CostCenter**: Education-Platform
- **Owner**: Infrastructure-Team

These tags enable:
- Cost allocation reporting
- Resource management
- Compliance tracking
- Automated governance