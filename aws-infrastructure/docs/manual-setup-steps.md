# Manual AWS Console Setup Steps

This document outlines the manual configuration steps required in the AWS Console to complete the account setup for Assisted CLIMB billing monitoring and cost optimization.

## Prerequisites

- AWS account with administrative access
- AWS CLI configured with admin credentials
- CDK infrastructure deployed successfully

## Step 1: Enable Cost Explorer (Required)

Cost Explorer provides detailed cost and usage insights essential for the educational platform's budget management.

### Instructions:
1. **Navigate to Cost Explorer**
   - Go to: https://console.aws.amazon.com/cost-management/home#/cost-explorer
   - Click **"Enable Cost Explorer"** if not already enabled

2. **Configure Cost Explorer Settings**
   - Enable **"Right Sizing Recommendations"**
   - Enable **"Reserved Instance Recommendations"**
   - Enable **"Savings Plans Recommendations"**

3. **Set Up Cost Categories** (Optional but recommended)
   - Create category: "Education Platform Core Services"
   - Include: ECS, RDS, Lambda, S3, CloudFront
   - Create category: "Infrastructure and Monitoring"
   - Include: CloudWatch, VPC, Route53, SNS

### Verification:
- Cost Explorer dashboard loads without errors
- Historical cost data is visible (may take 24 hours for new accounts)
- Recommendations are available (may take 48 hours)

## Step 2: Configure Billing Preferences

### Enable Billing Alerts:
1. **Navigate to Billing Preferences**
   - Go to: https://console.aws.amazon.com/billing/home#/preferences
   
2. **Enable Billing Alerts**
   - Check ✅ **"Receive Billing Alerts"**
   - Check ✅ **"Receive Free Tier Usage Alerts"**
   - Click **"Save preferences"**

### Configure Cost Allocation Tags:
1. **Go to Cost Allocation Tags**
   - Navigate to: https://console.aws.amazon.com/billing/home#/tags
   
2. **Activate User-Defined Tags**
   - Activate tags: `Project`, `Environment`, `CostCenter`, `Owner`
   - Click **"Activate"** for each tag
   - Note: Tag activation takes 24 hours to take effect

## Step 3: Confirm SNS Email Subscriptions

After CDK deployment, you'll receive email confirmations for billing alerts.

### Instructions:
1. **Check Email Inbox**
   - Look for emails from "AWS Notifications" 
   - Subject: "AWS Notification - Subscription Confirmation"

2. **Confirm Subscriptions**
   - Click **"Confirm subscription"** in each email
   - You should receive confirmations for:
     - Billing alerts topic
     - Operational alerts topic (if deployed)

3. **Verify Subscriptions**
   - Go to: https://console.aws.amazon.com/sns/home?region=us-east-1#/subscriptions
   - Confirm status shows "Confirmed" for all subscriptions

## Step 4: Configure Budget Actions (Advanced)

Set up automated actions when budget thresholds are exceeded.

### Instructions:
1. **Navigate to AWS Budgets**
   - Go to: https://console.aws.amazon.com/billing/home#/budgets

2. **Edit Existing Budget**
   - Click on "assisted-climb-monthly-budget"
   - Go to "Budget actions" tab

3. **Create Budget Actions**
   - **Action 1: Notification at 80%**
     - Threshold: 80% of budget
     - Action: Send notification to operations team
   
   - **Action 2: Resource Tagging at 90%**
     - Threshold: 90% of budget  
     - Action: Apply "OverBudget" tag to new resources
   
   - **Action 3: Prevent New Resources at 110%**
     - Threshold: 110% of budget
     - Action: Apply SCPs to prevent resource creation (Enterprise only)

## Step 5: Set Up Cost Optimization Reports

### Enable Cost and Usage Reports:
1. **Navigate to Cost and Usage Reports**
   - Go to: https://console.aws.amazon.com/billing/home#/reports

2. **Create Report**
   - Report name: "assisted-climb-detailed-billing"
   - Time unit: Daily
   - Include resource IDs: Yes
   - Data refresh settings: Automatically refresh
   - S3 bucket: Create new bucket or use existing
   - Report path prefix: "cost-reports/"
   - Compression: GZIP

3. **Configure Report Data**
   - Include: All available data
   - Enable: Split cost allocation data
   - Enable: Include reserved instance recommendations

## Step 6: Configure Reserved Instance Recommendations

To achieve maximum cost savings for the educational platform:

### Instructions:
1. **Go to Reserved Instances**
   - Navigate to: https://console.aws.amazon.com/ec2/home#ReservedInstances

2. **Purchase Recommendations**
   - Click **"Purchase Reserved Instances"**
   - Set recommendation parameters:
     - Lookback period: 30 days (for pilot) or 60 days (for production)
     - Term: 1 year (for flexibility) or 3 years (for maximum savings)
     - Payment: All upfront (maximum discount)
     - Instance type flexibility: Enabled

3. **RDS Reserved Instances**
   - Navigate to: https://console.aws.amazon.com/rds/home#reserved-instances
   - Purchase recommendations for PostgreSQL instances
   - Recommended: db.t3.small (1-year term, all upfront)

## Step 7: Security Configuration Review

### Enable AWS Config:
1. **Navigate to AWS Config**
   - Go to: https://console.aws.amazon.com/config/home

2. **Set Up Config Recorder**
   - Enable recording for all resource types
   - Include global resources (IAM roles, etc.)
   - Store in S3 bucket (create new or use existing)

3. **Enable Compliance Rules**
   - Add rules for:
     - S3 bucket encryption
     - RDS encryption at rest
     - VPC security groups
     - IAM password policy

### Enable GuardDuty (Recommended):
1. **Navigate to GuardDuty**
   - Go to: https://console.aws.amazon.com/guardduty/home

2. **Enable GuardDuty**
   - Click **"Enable GuardDuty"**
   - Accept default settings (30-day free trial)
   - Configure SNS notifications for findings

## Step 8: Validation and Testing

### Test Billing Alerts:
1. **Simulate Cost Spike** (Optional)
   - Create a large EC2 instance temporarily
   - Monitor CloudWatch metrics after 6 hours
   - Verify alert triggers properly
   - Terminate test instance immediately

2. **Verify Dashboard Access**
   - Cost Dashboard: Working and displaying data
   - Budget Dashboard: Shows current spend vs. budget
   - CloudWatch: Billing metrics visible

### Monitor for 48 Hours:
- SNS notifications working correctly
- Cost tracking functioning properly
- All budgets and alerts configured
- No unexpected charges appearing

## Troubleshooting

### Common Issues:

1. **Cost Explorer Not Enabled**
   - Ensure you have billing permissions
   - Wait 24 hours after enabling
   - Contact AWS support if issues persist

2. **SNS Subscriptions Not Confirmed**
   - Check spam/junk folders
   - Request new confirmation email
   - Verify email address is correct

3. **Billing Metrics Not Appearing**
   - Ensure account has spending activity
   - Wait 12-24 hours for first metrics
   - Verify billing alerts are enabled in preferences

4. **Budget Alerts Not Firing**
   - Check budget configuration and thresholds
   - Verify SNS topic permissions
   - Test with manual SNS publish

## Cost Optimization Checklist

After setup completion, ensure:

- [ ] Cost Explorer enabled and configured
- [ ] Billing alerts confirmed and tested  
- [ ] Budget tracking active with notifications
- [ ] Cost allocation tags activated
- [ ] Reserved Instance recommendations reviewed
- [ ] S3 Intelligent Tiering enabled
- [ ] VPC endpoints planned to avoid NAT Gateway costs
- [ ] Right-sizing recommendations reviewed monthly
- [ ] Cost anomaly detection configured
- [ ] Cost and Usage Reports generated

## Next Steps

1. **Deploy Application Infrastructure**
   - Proceed to VPC and network setup (Task 1.3)
   - Deploy ECS and RDS infrastructure
   - Configure application monitoring

2. **Ongoing Cost Management**
   - Review cost reports weekly during pilot
   - Analyze spending patterns monthly
   - Implement cost optimization recommendations
   - Monitor for any cost anomalies

3. **Scale for Production**
   - Adjust budgets for multi-school deployment
   - Implement automated cost controls
   - Set up detailed cost allocation by school
   - Configure enterprise-level cost management

## Success Criteria

The AWS account setup is complete when:
- ✅ All billing alerts are active and confirmed
- ✅ Cost Explorer provides detailed insights
- ✅ Budgets track spending accurately  
- ✅ SNS notifications are delivered reliably
- ✅ Cost optimization features are configured
- ✅ Security baseline is established
- ✅ Reserved Instance recommendations are available
- ✅ All manual steps documented and completed

This configuration ensures the Assisted CLIMB platform stays within the $100/month budget target while providing comprehensive cost monitoring and optimization.