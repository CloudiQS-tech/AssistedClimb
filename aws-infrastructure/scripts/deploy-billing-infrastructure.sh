#!/bin/bash

# Assisted CLIMB - Deploy Billing Infrastructure
# This script deploys the CDK stacks for comprehensive billing monitoring

set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Configuration
ALERT_EMAIL="${ALERT_EMAIL:-admin@assistedclimb.education}"
PROJECT_DIR="/Users/sitathomas/Assisted Climb/aws-infrastructure"
ACCOUNT_ID=""

echo -e "${BLUE}=== Assisted CLIMB Billing Infrastructure Deployment ===${NC}"

# Function to check prerequisites
check_prerequisites() {
    echo -e "${BLUE}Checking prerequisites...${NC}"
    
    # Check AWS CLI
    if ! command -v aws &> /dev/null; then
        echo -e "${RED}ERROR: AWS CLI not found${NC}"
        exit 1
    fi
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        echo -e "${RED}ERROR: Node.js not found${NC}"
        exit 1
    fi
    
    # Check CDK
    if ! command -v cdk &> /dev/null; then
        echo -e "${YELLOW}Installing AWS CDK globally...${NC}"
        npm install -g aws-cdk
    fi
    
    # Get AWS account info
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    echo -e "${GREEN}✓ Prerequisites checked - Account: $ACCOUNT_ID${NC}"
}

# Function to setup project
setup_project() {
    echo -e "${BLUE}Setting up CDK project...${NC}"
    
    cd "$PROJECT_DIR"
    
    # Install dependencies
    if [ ! -d "node_modules" ]; then
        echo "Installing npm dependencies..."
        npm install
    fi
    
    # Build TypeScript
    echo "Building TypeScript..."
    npm run build
    
    echo -e "${GREEN}✓ Project setup complete${NC}"
}

# Function to bootstrap CDK
bootstrap_cdk() {
    echo -e "${BLUE}Bootstrapping CDK environments...${NC}"
    
    # Bootstrap us-east-1 for billing
    echo "Bootstrapping us-east-1 for billing metrics..."
    cdk bootstrap aws://$ACCOUNT_ID/us-east-1
    
    # Bootstrap eu-west-2 for application
    echo "Bootstrapping eu-west-2 for application monitoring..."
    cdk bootstrap aws://$ACCOUNT_ID/eu-west-2
    
    echo -e "${GREEN}✓ CDK environments bootstrapped${NC}"
}

# Function to deploy billing alerts
deploy_billing_alerts() {
    echo -e "${BLUE}Deploying billing alerts stack (us-east-1)...${NC}"
    
    # Set environment variables
    export CDK_DEFAULT_ACCOUNT="$ACCOUNT_ID"
    export ALERT_EMAIL="$ALERT_EMAIL"
    
    # Deploy billing alerts stack
    cdk deploy AssistedClimbBillingAlertsStack \
        --require-approval never \
        --parameters AlertEmail="$ALERT_EMAIL"
    
    echo -e "${GREEN}✓ Billing alerts stack deployed${NC}"
}

# Function to deploy monitoring
deploy_monitoring() {
    echo -e "${BLUE}Deploying monitoring stack (eu-west-2)...${NC}"
    
    # Deploy monitoring stack
    cdk deploy AssistedClimbMonitoringStack \
        --require-approval never \
        --parameters AlertEmail="$ALERT_EMAIL"
    
    echo -e "${GREEN}✓ Monitoring stack deployed${NC}"
}

# Function to verify deployment
verify_deployment() {
    echo -e "${BLUE}Verifying deployment...${NC}"
    
    # Check CloudFormation stacks
    echo "Checking CloudFormation stacks..."
    
    BILLING_STACK_STATUS=$(aws cloudformation describe-stacks \
        --region us-east-1 \
        --stack-name assisted-climb-billing-alerts \
        --query 'Stacks[0].StackStatus' \
        --output text 2>/dev/null || echo "NOT_FOUND")
    
    MONITORING_STACK_STATUS=$(aws cloudformation describe-stacks \
        --region eu-west-2 \
        --stack-name assisted-climb-monitoring \
        --query 'Stacks[0].StackStatus' \
        --output text 2>/dev/null || echo "NOT_FOUND")
    
    echo "Billing Stack Status: $BILLING_STACK_STATUS"
    echo "Monitoring Stack Status: $MONITORING_STACK_STATUS"
    
    # Check SNS topics
    echo "Checking SNS topics..."
    
    BILLING_TOPIC_ARN=$(aws sns list-topics \
        --region us-east-1 \
        --query 'Topics[?contains(TopicArn, `assisted-climb-billing-alerts`)].TopicArn' \
        --output text 2>/dev/null || echo "")
    
    if [ -n "$BILLING_TOPIC_ARN" ]; then
        echo "✓ Billing alert topic: $BILLING_TOPIC_ARN"
        
        # Check subscriptions
        SUBSCRIPTION_COUNT=$(aws sns list-subscriptions-by-topic \
            --region us-east-1 \
            --topic-arn "$BILLING_TOPIC_ARN" \
            --query 'length(Subscriptions)' \
            --output text)
        echo "  Subscriptions: $SUBSCRIPTION_COUNT"
    else
        echo -e "${RED}✗ Billing alert topic not found${NC}"
    fi
    
    # Check CloudWatch alarms
    echo "Checking CloudWatch alarms..."
    
    ALARM_COUNT=$(aws cloudwatch describe-alarms \
        --region us-east-1 \
        --alarm-name-prefix "assisted-climb-billing" \
        --query 'length(MetricAlarms)' \
        --output text 2>/dev/null || echo "0")
    
    echo "Billing alarms created: $ALARM_COUNT"
    
    # Check budgets
    echo "Checking AWS Budgets..."
    
    BUDGET_COUNT=$(aws budgets describe-budgets \
        --account-id "$ACCOUNT_ID" \
        --query 'length(Budgets[?BudgetName.contains(@, `assisted-climb`)])' \
        --output text 2>/dev/null || echo "0")
    
    echo "Budgets created: $BUDGET_COUNT"
    
    echo -e "${GREEN}✓ Deployment verification complete${NC}"
}

# Function to display next steps
display_next_steps() {
    echo -e "\n${GREEN}=== Deployment Complete! ===${NC}"
    echo ""
    echo -e "${BLUE}Immediate Actions Required:${NC}"
    echo "1. Check your email ($ALERT_EMAIL) for SNS subscription confirmations"
    echo "2. Click 'Confirm subscription' in each email received"
    echo "3. Enable Cost Explorer manually in AWS Console"
    echo ""
    echo -e "${BLUE}AWS Console URLs:${NC}"
    echo "• Cost Dashboard: https://console.aws.amazon.com/cloudwatch/home?region=eu-west-2#dashboards:name=assisted-climb-cost-monitoring"
    echo "• Billing Console: https://console.aws.amazon.com/billing/home"
    echo "• Cost Explorer: https://console.aws.amazon.com/cost-management/home#/cost-explorer"
    echo "• CloudWatch Alarms: https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#alarmsV2:"
    echo "• SNS Subscriptions: https://console.aws.amazon.com/sns/home?region=us-east-1#/subscriptions"
    echo ""
    echo -e "${BLUE}Monitoring Setup:${NC}"
    echo "• Billing alerts active at \$50 and \$100"
    echo "• Monthly budget limit: \$100"
    echo "• Cost anomaly detection enabled"
    echo "• CloudWatch dashboards deployed"
    echo ""
    echo -e "${YELLOW}Manual Steps Remaining:${NC}"
    echo "• Follow docs/manual-setup-steps.md for complete configuration"
    echo "• Wait 24-48 hours for billing metrics to populate"
    echo "• Review cost optimization recommendations"
    echo ""
    echo -e "${GREEN}Budget Compliance Target: <\$100/month for pilot deployment${NC}"
}

# Function to handle errors
handle_error() {
    echo -e "${RED}ERROR: Deployment failed at step: $1${NC}"
    echo "Check the error message above and retry"
    exit 1
}

# Main deployment function
main() {
    echo -e "${BLUE}Starting Assisted CLIMB billing infrastructure deployment...${NC}"
    echo "Target: <\$100/month budget with comprehensive monitoring"
    echo "Alert Email: $ALERT_EMAIL"
    echo ""
    
    # Execute deployment steps
    check_prerequisites || handle_error "Prerequisites check"
    setup_project || handle_error "Project setup"
    bootstrap_cdk || handle_error "CDK bootstrap"
    deploy_billing_alerts || handle_error "Billing alerts deployment"
    deploy_monitoring || handle_error "Monitoring deployment"
    verify_deployment || handle_error "Deployment verification"
    display_next_steps
    
    echo -e "\n${GREEN}Billing infrastructure deployment completed successfully!${NC}"
    echo -e "${BLUE}Proceed with manual configuration steps and VPC infrastructure deployment.${NC}"
}

# Execute main function with error handling
main "$@"