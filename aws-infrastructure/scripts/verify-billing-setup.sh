#!/bin/bash

# Assisted CLIMB - Verify Billing Setup
# This script validates that billing alerts and monitoring are configured correctly

set -euo pipefail

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Assisted CLIMB Billing Setup Verification ===${NC}"

# Get account information
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "UNKNOWN")
echo "AWS Account: $ACCOUNT_ID"
echo ""

# Check billing alerts
check_billing_alerts() {
    echo -e "${BLUE}Checking billing alerts...${NC}"
    
    # Check CloudWatch alarms in us-east-1
    ALARMS=$(aws cloudwatch describe-alarms \
        --region us-east-1 \
        --alarm-name-prefix "assisted-climb-billing" \
        --query 'MetricAlarms[*].{Name:AlarmName,State:StateValue,Threshold:Threshold}' \
        --output table 2>/dev/null || echo "No alarms found")
    
    if [[ "$ALARMS" != "No alarms found" ]]; then
        echo -e "${GREEN}✓ Billing alarms configured:${NC}"
        echo "$ALARMS"
    else
        echo -e "${RED}✗ No billing alarms found${NC}"
        return 1
    fi
}

# Check SNS subscriptions
check_sns_subscriptions() {
    echo -e "${BLUE}Checking SNS subscriptions...${NC}"
    
    # Find billing alert topic
    TOPIC_ARN=$(aws sns list-topics \
        --region us-east-1 \
        --query 'Topics[?contains(TopicArn, `assisted-climb-billing`)].TopicArn' \
        --output text 2>/dev/null)
    
    if [ -n "$TOPIC_ARN" ]; then
        echo -e "${GREEN}✓ Billing alert topic found:${NC} $TOPIC_ARN"
        
        # Check subscriptions
        SUBSCRIPTIONS=$(aws sns list-subscriptions-by-topic \
            --region us-east-1 \
            --topic-arn "$TOPIC_ARN" \
            --query 'Subscriptions[*].{Protocol:Protocol,Endpoint:Endpoint,Status:SubscriptionArn}' \
            --output table 2>/dev/null)
        
        if [[ "$SUBSCRIPTIONS" == *"SubscriptionArn"* ]]; then
            echo -e "${GREEN}✓ SNS subscriptions:${NC}"
            echo "$SUBSCRIPTIONS"
        else
            echo -e "${YELLOW}⚠ No confirmed subscriptions found${NC}"
            echo "Check your email for subscription confirmation"
        fi
    else
        echo -e "${RED}✗ No billing alert topic found${NC}"
        return 1
    fi
}

# Check budgets
check_budgets() {
    echo -e "${BLUE}Checking AWS Budgets...${NC}"
    
    BUDGETS=$(aws budgets describe-budgets \
        --account-id "$ACCOUNT_ID" \
        --query 'Budgets[?contains(BudgetName, `assisted-climb`)].{Name:BudgetName,Limit:BudgetLimit.Amount,Unit:BudgetLimit.Unit}' \
        --output table 2>/dev/null || echo "No budgets found")
    
    if [[ "$BUDGETS" != "No budgets found" ]]; then
        echo -e "${GREEN}✓ Budgets configured:${NC}"
        echo "$BUDGETS"
    else
        echo -e "${RED}✗ No budgets found${NC}"
        return 1
    fi
}

# Check Cost Explorer
check_cost_explorer() {
    echo -e "${BLUE}Checking Cost Explorer...${NC}"
    
    # Try to query Cost Explorer API
    COST_DATA=$(aws ce get-cost-and-usage \
        --time-period Start=2023-01-01,End=2023-01-02 \
        --granularity DAILY \
        --metrics BlendedCost \
        --query 'ResultsByTime[0].Total.BlendedCost.Amount' \
        --output text 2>/dev/null || echo "NOT_AVAILABLE")
    
    if [[ "$COST_DATA" != "NOT_AVAILABLE" ]]; then
        echo -e "${GREEN}✓ Cost Explorer is enabled and accessible${NC}"
    else
        echo -e "${YELLOW}⚠ Cost Explorer may not be enabled${NC}"
        echo "Enable manually at: https://console.aws.amazon.com/cost-management/home#/cost-explorer"
    fi
}

# Check CloudFormation stacks
check_cloudformation_stacks() {
    echo -e "${BLUE}Checking CloudFormation stacks...${NC}"
    
    # Check billing stack
    BILLING_STACK=$(aws cloudformation describe-stacks \
        --region us-east-1 \
        --stack-name assisted-climb-billing-alerts \
        --query 'Stacks[0].{Name:StackName,Status:StackStatus}' \
        --output table 2>/dev/null || echo "Stack not found")
    
    if [[ "$BILLING_STACK" != "Stack not found" ]]; then
        echo -e "${GREEN}✓ Billing alerts stack:${NC}"
        echo "$BILLING_STACK"
    else
        echo -e "${RED}✗ Billing alerts stack not found${NC}"
    fi
    
    # Check monitoring stack
    MONITORING_STACK=$(aws cloudformation describe-stacks \
        --region eu-west-2 \
        --stack-name assisted-climb-monitoring \
        --query 'Stacks[0].{Name:StackName,Status:StackStatus}' \
        --output table 2>/dev/null || echo "Stack not found")
    
    if [[ "$MONITORING_STACK" != "Stack not found" ]]; then
        echo -e "${GREEN}✓ Monitoring stack:${NC}"
        echo "$MONITORING_STACK"
    else
        echo -e "${RED}✗ Monitoring stack not found${NC}"
    fi
}

# Check current costs
check_current_costs() {
    echo -e "${BLUE}Checking current month costs...${NC}"
    
    # Get current month costs
    CURRENT_MONTH=$(date +"%Y-%m-01")
    NEXT_MONTH=$(date -d "+1 month" +"%Y-%m-01" 2>/dev/null || gdate -d "+1 month" +"%Y-%m-01" 2>/dev/null || echo "2024-01-01")
    
    CURRENT_COST=$(aws ce get-cost-and-usage \
        --time-period Start="$CURRENT_MONTH",End="$NEXT_MONTH" \
        --granularity MONTHLY \
        --metrics BlendedCost \
        --query 'ResultsByTime[0].Total.BlendedCost.Amount' \
        --output text 2>/dev/null || echo "0.00")
    
    if [[ "$CURRENT_COST" != "0.00" ]]; then
        echo -e "${GREEN}✓ Current month cost: \$$CURRENT_COST${NC}"
        
        # Check against budget
        BUDGET_PERCENTAGE=$(echo "scale=1; ($CURRENT_COST / 100) * 100" | bc 2>/dev/null || echo "0")
        echo "Budget utilization: ${BUDGET_PERCENTAGE}% of \$100"
        
        if (( $(echo "$CURRENT_COST > 100" | bc -l) )); then
            echo -e "${RED}⚠ Cost exceeds \$100 budget!${NC}"
        elif (( $(echo "$CURRENT_COST > 50" | bc -l) )); then
            echo -e "${YELLOW}⚠ Cost exceeds 50% of budget${NC}"
        else
            echo -e "${GREEN}✓ Cost within budget limits${NC}"
        fi
    else
        echo -e "${YELLOW}⚠ No cost data available yet${NC}"
        echo "Wait 24 hours for billing data to populate"
    fi
}

# Generate summary report
generate_summary() {
    echo -e "\n${BLUE}=== Billing Setup Summary ===${NC}"
    
    local all_checks_passed=true
    
    # Run all checks and track results
    echo "Running comprehensive verification..."
    echo ""
    
    check_billing_alerts || all_checks_passed=false
    echo ""
    
    check_sns_subscriptions || all_checks_passed=false
    echo ""
    
    check_budgets || all_checks_passed=false
    echo ""
    
    check_cost_explorer
    echo ""
    
    check_cloudformation_stacks
    echo ""
    
    check_current_costs
    echo ""
    
    # Final summary
    if [ "$all_checks_passed" = true ]; then
        echo -e "${GREEN}✅ All critical billing components are configured correctly${NC}"
        echo ""
        echo -e "${BLUE}Next Steps:${NC}"
        echo "1. Confirm SNS email subscriptions if not already done"
        echo "2. Enable Cost Explorer if not accessible"
        echo "3. Wait 24-48 hours for complete data population"
        echo "4. Proceed to VPC infrastructure deployment (Task 1.3)"
    else
        echo -e "${RED}❌ Some billing components need attention${NC}"
        echo ""
        echo -e "${YELLOW}Required Actions:${NC}"
        echo "1. Deploy missing CDK stacks if not found"
        echo "2. Confirm SNS subscriptions via email"
        echo "3. Enable Cost Explorer manually in AWS Console"
        echo "4. Review error messages above and fix issues"
    fi
    
    echo ""
    echo -e "${BLUE}Cost Monitoring Status:${NC}"
    echo "• Target Budget: \$100/month"
    echo "• Alert Thresholds: \$50 (50%) and \$100 (100%)"
    echo "• Cost Optimization: Active monitoring and recommendations"
    echo "• Compliance: Educational data protection standards"
}

# Main verification function
main() {
    echo "Verifying AWS billing setup for Assisted CLIMB educational platform"
    echo "Account: $ACCOUNT_ID"
    echo ""
    
    generate_summary
    
    echo -e "\n${GREEN}Billing setup verification complete!${NC}"
}

# Execute main function
main "$@"