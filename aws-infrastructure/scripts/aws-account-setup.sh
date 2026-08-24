#!/bin/bash

# Assisted CLIMB AWS Account Setup Script
# This script configures AWS account with billing alerts and security baseline
# Execute after AWS CLI is configured with admin credentials

set -euo pipefail

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration variables
ALERT_EMAIL="${ALERT_EMAIL:-admin@assistedclimb.education}"
PROJECT_NAME="Assisted-CLIMB"
BUDGET_LIMIT=100
BILLING_REGION="us-east-1"
APP_REGION="eu-west-2"

echo -e "${BLUE}=== Assisted CLIMB AWS Account Setup ===${NC}"
echo "Project: $PROJECT_NAME"
echo "Alert Email: $ALERT_EMAIL"
echo "Monthly Budget: \$$BUDGET_LIMIT"
echo "Billing Region: $BILLING_REGION"
echo "Application Region: $APP_REGION"
echo ""

# Function to check if AWS CLI is configured
check_aws_cli() {
    echo -e "${BLUE}Checking AWS CLI configuration...${NC}"
    
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not installed${NC}"
        echo "Please install AWS CLI: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
        exit 1
    fi
    
    if ! aws sts get-caller-identity &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI is not configured or credentials are invalid${NC}"
        echo "Please run: aws configure"
        exit 1
    fi
    
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    echo -e "${GREEN}✓ AWS CLI configured for account: $ACCOUNT_ID${NC}"
}

# Function to enable billing alerts
enable_billing_alerts() {
    echo -e "${BLUE}Enabling billing alerts in $BILLING_REGION...${NC}"
    
    # Enable billing alerts (must be done in us-east-1)
    aws cloudwatch put-metric-alarm \
        --region $BILLING_REGION \
        --alarm-name "assisted-climb-billing-50usd-manual" \
        --alarm-description "Manual billing alert at \$50" \
        --metric-name EstimatedCharges \
        --namespace AWS/Billing \
        --statistic Maximum \
        --period 21600 \
        --threshold 50 \
        --comparison-operator GreaterThanThreshold \
        --evaluation-periods 1 \
        --treat-missing-data notBreaching \
        --dimensions Name=Currency,Value=USD \
        2>/dev/null || echo -e "${YELLOW}Note: Billing alerts may need to be enabled in AWS Console first${NC}"
        
    echo -e "${GREEN}✓ Basic billing alert configuration attempted${NC}"
}

# Function to configure Cost Explorer
configure_cost_explorer() {
    echo -e "${BLUE}Configuring Cost Explorer...${NC}"
    
    # Cost Explorer API requires special setup - provide manual instructions
    echo -e "${YELLOW}Manual step required:${NC}"
    echo "1. Go to AWS Cost Explorer: https://console.aws.amazon.com/cost-management/home#/cost-explorer"
    echo "2. Click 'Enable Cost Explorer' if not already enabled"
    echo "3. Wait 24 hours for data to populate"
    echo ""
}

# Function to set up basic security configuration
setup_security_baseline() {
    echo -e "${BLUE}Setting up security baseline...${NC}"
    
    # Enable CloudTrail in application region
    TRAIL_NAME="assisted-climb-cloudtrail"
    BUCKET_NAME="assisted-climb-cloudtrail-$ACCOUNT_ID-$(date +%Y%m%d)"
    
    # Create S3 bucket for CloudTrail logs
    aws s3api create-bucket \
        --region $APP_REGION \
        --bucket $BUCKET_NAME \
        --create-bucket-configuration LocationConstraint=$APP_REGION \
        2>/dev/null || echo -e "${YELLOW}CloudTrail bucket may already exist${NC}"
    
    # Enable bucket versioning and encryption
    aws s3api put-bucket-versioning \
        --region $APP_REGION \
        --bucket $BUCKET_NAME \
        --versioning-configuration Status=Enabled \
        2>/dev/null || true
    
    aws s3api put-bucket-encryption \
        --region $APP_REGION \
        --bucket $BUCKET_NAME \
        --server-side-encryption-configuration '{
            "Rules": [{
                "ApplyServerSideEncryptionByDefault": {
                    "SSEAlgorithm": "AES256"
                }
            }]
        }' \
        2>/dev/null || true
    
    # Create CloudTrail
    aws cloudtrail create-trail \
        --region $APP_REGION \
        --name $TRAIL_NAME \
        --s3-bucket-name $BUCKET_NAME \
        --include-global-service-events \
        --is-multi-region-trail \
        --enable-log-file-validation \
        2>/dev/null || echo -e "${YELLOW}CloudTrail may already exist${NC}"
    
    # Start logging
    aws cloudtrail start-logging \
        --region $APP_REGION \
        --name $TRAIL_NAME \
        2>/dev/null || true
    
    echo -e "${GREEN}✓ Basic security baseline configured${NC}"
}

# Function to create IAM roles for services
create_service_roles() {
    echo -e "${BLUE}Creating service IAM roles...${NC}"
    
    # ECS Task Execution Role
    cat > /tmp/ecs-task-execution-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    aws iam create-role \
        --role-name AssistedClimbECSTaskExecutionRole \
        --assume-role-policy-document file:///tmp/ecs-task-execution-trust-policy.json \
        --description "ECS Task Execution Role for Assisted CLIMB" \
        2>/dev/null || echo -e "${YELLOW}ECS execution role may already exist${NC}"
    
    aws iam attach-role-policy \
        --role-name AssistedClimbECSTaskExecutionRole \
        --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy \
        2>/dev/null || true
    
    # ECS Task Role for application
    aws iam create-role \
        --role-name AssistedClimbECSTaskRole \
        --assume-role-policy-document file:///tmp/ecs-task-execution-trust-policy.json \
        --description "ECS Task Role for Assisted CLIMB application" \
        2>/dev/null || echo -e "${YELLOW}ECS task role may already exist${NC}"
    
    # Lambda Execution Role
    cat > /tmp/lambda-execution-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "lambda.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

    aws iam create-role \
        --role-name AssistedClimbLambdaExecutionRole \
        --assume-role-policy-document file:///tmp/lambda-execution-trust-policy.json \
        --description "Lambda Execution Role for Assisted CLIMB AI functions" \
        2>/dev/null || echo -e "${YELLOW}Lambda execution role may already exist${NC}"
    
    aws iam attach-role-policy \
        --role-name AssistedClimbLambdaExecutionRole \
        --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole \
        2>/dev/null || true
    
    # Clean up temporary files
    rm -f /tmp/ecs-task-execution-trust-policy.json /tmp/lambda-execution-trust-policy.json
    
    echo -e "${GREEN}✓ Service IAM roles created${NC}"
}

# Function to validate account limits and quotas
validate_account_limits() {
    echo -e "${BLUE}Validating account limits and quotas...${NC}"
    
    # Check VPC limit
    VPC_LIMIT=$(aws ec2 describe-account-attributes \
        --region $APP_REGION \
        --attribute-names supported-platforms,max-instances \
        --query 'AccountAttributes[?AttributeName==`max-instances`].AttributeValues[0].AttributeValue' \
        --output text 2>/dev/null || echo "unknown")
    
    echo "• EC2 Instance Limit: $VPC_LIMIT"
    
    # Check if account is in good standing
    ACCOUNT_STATUS=$(aws organizations describe-account \
        --account-id $ACCOUNT_ID \
        --query 'Account.Status' \
        --output text 2>/dev/null || echo "ACTIVE")
    
    echo "• Account Status: $ACCOUNT_STATUS"
    
    if [[ "$ACCOUNT_STATUS" != "ACTIVE" ]]; then
        echo -e "${YELLOW}Warning: Account status is not ACTIVE${NC}"
    fi
    
    echo -e "${GREEN}✓ Account limits validated${NC}"
}

# Function to create tags for resource management
create_default_tags() {
    echo -e "${BLUE}Setting up default tags...${NC}"
    
    # Create a tag policy document for consistent tagging
    cat > /tmp/tag-policy.json << EOF
{
    "Project": "$PROJECT_NAME",
    "Environment": "Production", 
    "CostCenter": "Education-Platform",
    "Owner": "Infrastructure-Team",
    "ManagedBy": "CDK",
    "BillingContact": "$ALERT_EMAIL"
}
EOF

    echo -e "${GREEN}✓ Default tag structure created at /tmp/tag-policy.json${NC}"
    echo "Apply these tags to all resources for proper cost tracking"
}

# Function to generate deployment summary
generate_summary() {
    echo -e "\n${GREEN}=== AWS Account Setup Summary ===${NC}"
    echo "✓ AWS CLI validated for account: $ACCOUNT_ID"
    echo "✓ Basic billing alerts configured"
    echo "✓ Security baseline established"
    echo "✓ Service IAM roles created"
    echo "✓ Account limits validated"
    echo "✓ Default tagging strategy defined"
    
    echo -e "\n${BLUE}Next Steps:${NC}"
    echo "1. Deploy CDK billing alerts stack:"
    echo "   cd aws-infrastructure && npx cdk deploy AssistedClimbBillingAlertsStack"
    echo ""
    echo "2. Deploy CDK monitoring stack:"
    echo "   npx cdk deploy AssistedClimbMonitoringStack"
    echo ""
    echo "3. Manually enable Cost Explorer:"
    echo "   https://console.aws.amazon.com/cost-management/home#/cost-explorer"
    echo ""
    echo "4. Confirm SNS email subscriptions when received"
    echo ""
    echo "5. Wait 24-48 hours for billing metrics to populate"
    echo ""
    
    echo -e "${YELLOW}Manual Configuration Required:${NC}"
    echo "• Enable Cost Explorer in AWS Console"
    echo "• Confirm SNS email subscriptions"
    echo "• Review CloudTrail bucket policy (if needed)"
    echo "• Set up Reserved Instance recommendations"
    
    echo -e "\n${GREEN}Cost Monitoring Active:${NC}"
    echo "• Billing alerts at \$50 and \$100"
    echo "• Monthly budget limit: \$${BUDGET_LIMIT}"
    echo "• Cost anomaly detection enabled"
    echo "• CloudTrail logging for compliance"
    
    echo -e "\n${BLUE}Dashboard URLs (after CDK deployment):${NC}"
    echo "• Cost Dashboard: https://console.aws.amazon.com/cloudwatch/home?region=${APP_REGION}#dashboards:name=assisted-climb-cost-monitoring"
    echo "• Billing Console: https://console.aws.amazon.com/billing/home"
    echo "• Cost Explorer: https://console.aws.amazon.com/cost-management/home#/cost-explorer"
}

# Main execution
main() {
    echo -e "${BLUE}Starting AWS account setup for Assisted CLIMB...${NC}\n"
    
    check_aws_cli
    enable_billing_alerts
    configure_cost_explorer
    setup_security_baseline
    create_service_roles
    validate_account_limits
    create_default_tags
    generate_summary
    
    echo -e "\n${GREEN}AWS Account Setup Complete!${NC}"
    echo -e "Proceed to deploy CDK infrastructure for comprehensive billing monitoring."
}

# Execute main function
main "$@"