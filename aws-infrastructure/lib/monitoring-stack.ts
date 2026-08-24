import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  /**
   * Email address for operational alerts
   * @default 'ops@assistedclimb.education'
   */
  alertEmail?: string;
}

export class MonitoringStack extends cdk.Stack {
  public readonly operationalAlertTopic: sns.Topic;
  public readonly costDashboard: cloudwatch.Dashboard;
  
  constructor(scope: Construct, id: string, props: MonitoringStackProps = {}) {
    super(scope, id, props);

    const { alertEmail = 'ops@assistedclimb.education' } = props;

    // SNS Topic for operational alerts
    this.operationalAlertTopic = new sns.Topic(this, 'OperationalAlertTopic', {
      topicName: 'assisted-climb-operational-alerts',
      displayName: 'Assisted CLIMB Operational Alerts',
      description: 'SNS topic for operational and performance alerts'
    });

    // Email subscription for operational alerts
    this.operationalAlertTopic.addSubscription(
      new subscriptions.EmailSubscription(alertEmail)
    );

    // Create cost monitoring dashboard
    this.costDashboard = this.createCostDashboard();

    // Create operational monitoring dashboard
    this.createOperationalDashboard();

    // Set up Cost Explorer configuration (via CloudFormation custom resource)
    this.enableCostExplorer();

    // Output important information
    new cdk.CfnOutput(this, 'CostDashboardUrl', {
      value: `https://console.aws.amazon.com/cloudwatch/home?region=${this.region}#dashboards:name=${this.costDashboard.dashboardName}`,
      description: 'URL to the Cost Monitoring Dashboard'
    });

    new cdk.CfnOutput(this, 'OperationalAlertTopicArn', {
      value: this.operationalAlertTopic.topicArn,
      description: 'ARN of the SNS topic for operational alerts'
    });
  }

  private createCostDashboard(): cloudwatch.Dashboard {
    const dashboard = new cloudwatch.Dashboard(this, 'CostDashboard', {
      dashboardName: 'assisted-climb-cost-monitoring',
      defaultInterval: cdk.Duration.hours(24)
    });

    // Billing metrics widget
    const billingWidget = new cloudwatch.GraphWidget({
      title: 'AWS Billing - Estimated Charges',
      left: [new cloudwatch.Metric({
        namespace: 'AWS/Billing',
        metricName: 'EstimatedCharges',
        dimensionsMap: { Currency: 'USD' },
        statistic: 'Maximum',
        period: cdk.Duration.hours(6)
      })],
      width: 12,
      height: 6,
      leftYAxis: {
        min: 0,
        max: 150, // Set max to 150% of budget for visibility
        label: 'Cost (USD)'
      }
    });

    // Service-specific cost tracking
    const servicesCostWidget = new cloudwatch.GraphWidget({
      title: 'Cost by Service',
      left: [
        // These metrics would be populated by Cost and Usage Reports
        new cloudwatch.Metric({
          namespace: 'AWS/Billing',
          metricName: 'EstimatedCharges',
          dimensionsMap: { 
            Currency: 'USD',
            ServiceName: 'AmazonECS'
          },
          statistic: 'Maximum',
          period: cdk.Duration.hours(24)
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Billing',
          metricName: 'EstimatedCharges',
          dimensionsMap: { 
            Currency: 'USD',
            ServiceName: 'AmazonRDS'
          },
          statistic: 'Maximum',
          period: cdk.Duration.hours(24)
        }),
        new cloudwatch.Metric({
          namespace: 'AWS/Billing',
          metricName: 'EstimatedCharges',
          dimensionsMap: { 
            Currency: 'USD',
            ServiceName: 'AmazonS3'
          },
          statistic: 'Maximum',
          period: cdk.Duration.hours(24)
        })
      ],
      width: 12,
      height: 6
    });

    // Budget utilization text widget
    const budgetTextWidget = new cloudwatch.TextWidget({
      markdown: `
# Cost Optimization Dashboard

## Monthly Budget Target: $100
- **Pilot Phase (1-10 schools)**: Target <$100/month
- **Production Phase**: Target <$10/school/month
- **Cost Reduction Goal**: 90% vs Replit scaling costs

## Key Cost Centers
1. **ECS Fargate**: Compute containers for frontend/backend
2. **RDS PostgreSQL**: Database hosting (Single-AZ)
3. **CloudFront**: CDN for global content delivery
4. **Lambda**: AI integration and serverless functions
5. **S3**: Static assets and backups

## Cost Optimization Strategies
- Reserved Instances for RDS (up to 60% savings)
- VPC Endpoints to avoid NAT Gateway costs
- CloudFront caching to reduce ALB requests
- Right-sized ECS tasks based on monitoring
- S3 Intelligent Tiering for automatic cost optimization

## Alert Thresholds
- 🟡 **$50**: 50% budget alert
- 🔴 **$100**: 100% budget alert (action required)
- 🚨 **$120**: 120% budget critical alert
      `,
      width: 24,
      height: 8
    });

    dashboard.addWidgets(budgetTextWidget);
    dashboard.addWidgets(billingWidget, servicesCostWidget);

    return dashboard;
  }

  private createOperationalDashboard(): void {
    const operationalDashboard = new cloudwatch.Dashboard(this, 'OperationalDashboard', {
      dashboardName: 'assisted-climb-operations',
      defaultInterval: cdk.Duration.hours(1)
    });

    // Placeholder widgets for future ECS, RDS, and Lambda metrics
    const placeholderWidget = new cloudwatch.TextWidget({
      markdown: `
# Assisted CLIMB Operations Dashboard

This dashboard will be populated with operational metrics once the application infrastructure is deployed.

## Planned Metrics
- **ECS Service Health**: Task count, CPU/Memory utilization, deployment status
- **RDS Performance**: Connection count, query performance, storage usage
- **ALB Metrics**: Request count, response times, error rates
- **Lambda Performance**: Duration, error rate, concurrent executions
- **CloudFront**: Cache hit ratio, origin requests, global distribution

## Alert Thresholds (To Be Configured)
- ECS CPU > 80% for 10 minutes
- RDS connections > 80% of max
- ALB error rate > 5%
- Lambda duration > 30 seconds
- Lambda error rate > 1%

*This dashboard will be updated as infrastructure components are deployed.*
      `,
      width: 24,
      height: 12
    });

    operationalDashboard.addWidgets(placeholderWidget);
  }

  private enableCostExplorer(): void {
    // Custom resource to enable Cost Explorer and Cost and Usage Reports
    const enableCostExplorerRole = new iam.Role(this, 'EnableCostExplorerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
      ],
      inlinePolicies: {
        CostExplorerPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                'ce:*',
                'cur:*',
                'organizations:ListAccounts',
                'organizations:DescribeAccount'
              ],
              resources: ['*']
            })
          ]
        })
      }
    });

    // Lambda function to enable Cost Explorer
    const enableCostExplorerFunction = new cdk.aws_lambda.Function(this, 'EnableCostExplorerFunction', {
      runtime: cdk.aws_lambda.Runtime.PYTHON_3_9,
      handler: 'index.handler',
      role: enableCostExplorerRole,
      code: cdk.aws_lambda.Code.fromInline(`
import boto3
import json
import cfnresponse

def handler(event, context):
    try:
        ce_client = boto3.client('ce', region_name='us-east-1')
        
        if event['RequestType'] == 'Create' or event['RequestType'] == 'Update':
            # Enable Cost Explorer (this API call is idempotent)
            try:
                ce_client.get_cost_and_usage(
                    TimePeriod={'Start': '2023-01-01', 'End': '2023-01-02'},
                    Granularity='DAILY',
                    Metrics=['BlendedCost']
                )
                print("Cost Explorer is already enabled or successfully enabled")
            except Exception as e:
                print(f"Cost Explorer setup: {str(e)}")
                # Cost Explorer might already be enabled, which is fine
            
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {
                'Message': 'Cost Explorer configuration completed'
            })
        elif event['RequestType'] == 'Delete':
            # No action needed for delete
            cfnresponse.send(event, context, cfnresponse.SUCCESS, {})
    except Exception as e:
        print(f"Error: {str(e)}")
        cfnresponse.send(event, context, cfnresponse.FAILED, {})
      `),
      timeout: cdk.Duration.minutes(2)
    });

    // Custom resource to trigger the Lambda function
    new cdk.CustomResource(this, 'EnableCostExplorerCustomResource', {
      serviceToken: enableCostExplorerFunction.functionArn,
      properties: {
        AccountId: this.account,
        Timestamp: Date.now() // Force update on stack updates
      }
    });
  }
}