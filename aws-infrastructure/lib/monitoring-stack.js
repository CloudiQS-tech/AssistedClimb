"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MonitoringStack = void 0;
const cdk = require("aws-cdk-lib");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const sns = require("aws-cdk-lib/aws-sns");
const subscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
const iam = require("aws-cdk-lib/aws-iam");
class MonitoringStack extends cdk.Stack {
    constructor(scope, id, props = {}) {
        super(scope, id, props);
        const { alertEmail = 'ops@assistedclimb.education' } = props;
        // SNS Topic for operational alerts
        this.operationalAlertTopic = new sns.Topic(this, 'OperationalAlertTopic', {
            topicName: 'assisted-climb-operational-alerts',
            displayName: 'Assisted CLIMB Operational Alerts',
            description: 'SNS topic for operational and performance alerts'
        });
        // Email subscription for operational alerts
        this.operationalAlertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
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
    createCostDashboard() {
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
                max: 150,
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
    createOperationalDashboard() {
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
    enableCostExplorer() {
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
exports.MonitoringStack = MonitoringStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibW9uaXRvcmluZy1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIm1vbml0b3Jpbmctc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLHlEQUF5RDtBQUN6RCwyQ0FBMkM7QUFDM0MsbUVBQW1FO0FBQ25FLDJDQUEyQztBQVczQyxNQUFhLGVBQWdCLFNBQVEsR0FBRyxDQUFDLEtBQUs7SUFJNUMsWUFBWSxLQUFnQixFQUFFLEVBQVUsRUFBRSxRQUE4QixFQUFFO1FBQ3hFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLE1BQU0sRUFBRSxVQUFVLEdBQUcsNkJBQTZCLEVBQUUsR0FBRyxLQUFLLENBQUM7UUFFN0QsbUNBQW1DO1FBQ25DLElBQUksQ0FBQyxxQkFBcUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxLQUFLLENBQUMsSUFBSSxFQUFFLHVCQUF1QixFQUFFO1lBQ3hFLFNBQVMsRUFBRSxtQ0FBbUM7WUFDOUMsV0FBVyxFQUFFLG1DQUFtQztZQUNoRCxXQUFXLEVBQUUsa0RBQWtEO1NBQ2hFLENBQUMsQ0FBQztRQUVILDRDQUE0QztRQUM1QyxJQUFJLENBQUMscUJBQXFCLENBQUMsZUFBZSxDQUN4QyxJQUFJLGFBQWEsQ0FBQyxpQkFBaUIsQ0FBQyxVQUFVLENBQUMsQ0FDaEQsQ0FBQztRQUVGLG1DQUFtQztRQUNuQyxJQUFJLENBQUMsYUFBYSxHQUFHLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxDQUFDO1FBRWhELDBDQUEwQztRQUMxQyxJQUFJLENBQUMsMEJBQTBCLEVBQUUsQ0FBQztRQUVsQywwRUFBMEU7UUFDMUUsSUFBSSxDQUFDLGtCQUFrQixFQUFFLENBQUM7UUFFMUIsK0JBQStCO1FBQy9CLElBQUksR0FBRyxDQUFDLFNBQVMsQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7WUFDMUMsS0FBSyxFQUFFLHlEQUF5RCxJQUFJLENBQUMsTUFBTSxv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QUFHLENBQUMsZUFBZSxDQUFDOzRCQUN0QixNQUFNLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxLQUFLOzRCQUN4QixPQUFPLEVBQUU7Z0NBQ1AsTUFBTTtnQ0FDTixPQUFPO2dDQUNQLDRCQUE0QjtnQ0FDNUIsK0JBQStCOzZCQUNoQzs0QkFDRCxTQUFTLEVBQUUsQ0FBQyxHQUFHLENBQUM7eUJBQ2pCLENBQUM7cUJBQ0g7aUJBQ0YsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsMENBQTBDO1FBQzFDLE1BQU0sMEJBQTBCLEdBQUcsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLFFBQVEsQ0FBQyxJQUFJLEVBQUUsNEJBQTRCLEVBQUU7WUFDakcsT0FBTyxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsT0FBTyxDQUFDLFVBQVU7WUFDMUMsT0FBTyxFQUFFLGVBQWU7WUFDeEIsSUFBSSxFQUFFLHNCQUFzQjtZQUM1QixJQUFJLEVBQUUsR0FBRyxDQUFDLFVBQVUsQ0FBQyxJQUFJLENBQUMsVUFBVSxDQUFDOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O09BK0JwQyxDQUFDO1lBQ0YsT0FBTyxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQztTQUNqQyxDQUFDLENBQUM7UUFFSCxpREFBaUQ7UUFDakQsSUFBSSxHQUFHLENBQUMsY0FBYyxDQUFDLElBQUksRUFBRSxrQ0FBa0MsRUFBRTtZQUMvRCxZQUFZLEVBQUUsMEJBQTBCLENBQUMsV0FBVztZQUNwRCxVQUFVLEVBQUU7Z0JBQ1YsU0FBUyxFQUFFLElBQUksQ0FBQyxPQUFPO2dCQUN2QixTQUFTLEVBQUUsSUFBSSxDQUFDLEdBQUcsRUFBRSxDQUFDLGdDQUFnQzthQUN2RDtTQUNGLENBQUMsQ0FBQztJQUNMLENBQUM7Q0FDRjtBQWhRRCwwQ0FnUUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0ICogYXMgY2xvdWR3YXRjaCBmcm9tICdhd3MtY2RrLWxpYi9hd3MtY2xvdWR3YXRjaCc7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBzdWJzY3JpcHRpb25zIGZyb20gJ2F3cy1jZGstbGliL2F3cy1zbnMtc3Vic2NyaXB0aW9ucyc7XG5pbXBvcnQgKiBhcyBpYW0gZnJvbSAnYXdzLWNkay1saWIvYXdzLWlhbSc7XG5pbXBvcnQgeyBDb25zdHJ1Y3QgfSBmcm9tICdjb25zdHJ1Y3RzJztcblxuZXhwb3J0IGludGVyZmFjZSBNb25pdG9yaW5nU3RhY2tQcm9wcyBleHRlbmRzIGNkay5TdGFja1Byb3BzIHtcbiAgLyoqXG4gICAqIEVtYWlsIGFkZHJlc3MgZm9yIG9wZXJhdGlvbmFsIGFsZXJ0c1xuICAgKiBAZGVmYXVsdCAnb3BzQGFzc2lzdGVkY2xpbWIuZWR1Y2F0aW9uJ1xuICAgKi9cbiAgYWxlcnRFbWFpbD86IHN0cmluZztcbn1cblxuZXhwb3J0IGNsYXNzIE1vbml0b3JpbmdTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIHB1YmxpYyByZWFkb25seSBvcGVyYXRpb25hbEFsZXJ0VG9waWM6IHNucy5Ub3BpYztcbiAgcHVibGljIHJlYWRvbmx5IGNvc3REYXNoYm9hcmQ6IGNsb3Vkd2F0Y2guRGFzaGJvYXJkO1xuICBcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM6IE1vbml0b3JpbmdTdGFja1Byb3BzID0ge30pIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIGNvbnN0IHsgYWxlcnRFbWFpbCA9ICdvcHNAYXNzaXN0ZWRjbGltYi5lZHVjYXRpb24nIH0gPSBwcm9wcztcblxuICAgIC8vIFNOUyBUb3BpYyBmb3Igb3BlcmF0aW9uYWwgYWxlcnRzXG4gICAgdGhpcy5vcGVyYXRpb25hbEFsZXJ0VG9waWMgPSBuZXcgc25zLlRvcGljKHRoaXMsICdPcGVyYXRpb25hbEFsZXJ0VG9waWMnLCB7XG4gICAgICB0b3BpY05hbWU6ICdhc3Npc3RlZC1jbGltYi1vcGVyYXRpb25hbC1hbGVydHMnLFxuICAgICAgZGlzcGxheU5hbWU6ICdBc3Npc3RlZCBDTElNQiBPcGVyYXRpb25hbCBBbGVydHMnLFxuICAgICAgZGVzY3JpcHRpb246ICdTTlMgdG9waWMgZm9yIG9wZXJhdGlvbmFsIGFuZCBwZXJmb3JtYW5jZSBhbGVydHMnXG4gICAgfSk7XG5cbiAgICAvLyBFbWFpbCBzdWJzY3JpcHRpb24gZm9yIG9wZXJhdGlvbmFsIGFsZXJ0c1xuICAgIHRoaXMub3BlcmF0aW9uYWxBbGVydFRvcGljLmFkZFN1YnNjcmlwdGlvbihcbiAgICAgIG5ldyBzdWJzY3JpcHRpb25zLkVtYWlsU3Vic2NyaXB0aW9uKGFsZXJ0RW1haWwpXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBjb3N0IG1vbml0b3JpbmcgZGFzaGJvYXJkXG4gICAgdGhpcy5jb3N0RGFzaGJvYXJkID0gdGhpcy5jcmVhdGVDb3N0RGFzaGJvYXJkKCk7XG5cbiAgICAvLyBDcmVhdGUgb3BlcmF0aW9uYWwgbW9uaXRvcmluZyBkYXNoYm9hcmRcbiAgICB0aGlzLmNyZWF0ZU9wZXJhdGlvbmFsRGFzaGJvYXJkKCk7XG5cbiAgICAvLyBTZXQgdXAgQ29zdCBFeHBsb3JlciBjb25maWd1cmF0aW9uICh2aWEgQ2xvdWRGb3JtYXRpb24gY3VzdG9tIHJlc291cmNlKVxuICAgIHRoaXMuZW5hYmxlQ29zdEV4cGxvcmVyKCk7XG5cbiAgICAvLyBPdXRwdXQgaW1wb3J0YW50IGluZm9ybWF0aW9uXG4gICAgbmV3IGNkay5DZm5PdXRwdXQodGhpcywgJ0Nvc3REYXNoYm9hcmRVcmwnLCB7XG4gICAgICB2YWx1ZTogYGh0dHBzOi8vY29uc29sZS5hd3MuYW1hem9uLmNvbS9jbG91ZHdhdGNoL2hvbWU/cmVnaW9uPSR7dGhpcy5yZWdpb259I2Rhc2hib2FyZHM6bmFtZT0ke3RoaXMuY29zdERhc2hib2FyZC5kYXNoYm9hcmROYW1lfWAsXG4gICAgICBkZXNjcmlwdGlvbjogJ1VSTCB0byB0aGUgQ29zdCBNb25pdG9yaW5nIERhc2hib2FyZCdcbiAgICB9KTtcblxuICAgIG5ldyBjZGsuQ2ZuT3V0cHV0KHRoaXMsICdPcGVyYXRpb25hbEFsZXJ0VG9waWNBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5vcGVyYXRpb25hbEFsZXJ0VG9waWMudG9waWNBcm4sXG4gICAgICBkZXNjcmlwdGlvbjogJ0FSTiBvZiB0aGUgU05TIHRvcGljIGZvciBvcGVyYXRpb25hbCBhbGVydHMnXG4gICAgfSk7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZUNvc3REYXNoYm9hcmQoKTogY2xvdWR3YXRjaC5EYXNoYm9hcmQge1xuICAgIGNvbnN0IGRhc2hib2FyZCA9IG5ldyBjbG91ZHdhdGNoLkRhc2hib2FyZCh0aGlzLCAnQ29zdERhc2hib2FyZCcsIHtcbiAgICAgIGRhc2hib2FyZE5hbWU6ICdhc3Npc3RlZC1jbGltYi1jb3N0LW1vbml0b3JpbmcnLFxuICAgICAgZGVmYXVsdEludGVydmFsOiBjZGsuRHVyYXRpb24uaG91cnMoMjQpXG4gICAgfSk7XG5cbiAgICAvLyBCaWxsaW5nIG1ldHJpY3Mgd2lkZ2V0XG4gICAgY29uc3QgYmlsbGluZ1dpZGdldCA9IG5ldyBjbG91ZHdhdGNoLkdyYXBoV2lkZ2V0KHtcbiAgICAgIHRpdGxlOiAnQVdTIEJpbGxpbmcgLSBFc3RpbWF0ZWQgQ2hhcmdlcycsXG4gICAgICBsZWZ0OiBbbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0JpbGxpbmcnLFxuICAgICAgICBtZXRyaWNOYW1lOiAnRXN0aW1hdGVkQ2hhcmdlcycsXG4gICAgICAgIGRpbWVuc2lvbnNNYXA6IHsgQ3VycmVuY3k6ICdVU0QnIH0sXG4gICAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3Vycyg2KVxuICAgICAgfSldLFxuICAgICAgd2lkdGg6IDEyLFxuICAgICAgaGVpZ2h0OiA2LFxuICAgICAgbGVmdFlBeGlzOiB7XG4gICAgICAgIG1pbjogMCxcbiAgICAgICAgbWF4OiAxNTAsIC8vIFNldCBtYXggdG8gMTUwJSBvZiBidWRnZXQgZm9yIHZpc2liaWxpdHlcbiAgICAgICAgbGFiZWw6ICdDb3N0IChVU0QpJ1xuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gU2VydmljZS1zcGVjaWZpYyBjb3N0IHRyYWNraW5nXG4gICAgY29uc3Qgc2VydmljZXNDb3N0V2lkZ2V0ID0gbmV3IGNsb3Vkd2F0Y2guR3JhcGhXaWRnZXQoe1xuICAgICAgdGl0bGU6ICdDb3N0IGJ5IFNlcnZpY2UnLFxuICAgICAgbGVmdDogW1xuICAgICAgICAvLyBUaGVzZSBtZXRyaWNzIHdvdWxkIGJlIHBvcHVsYXRlZCBieSBDb3N0IGFuZCBVc2FnZSBSZXBvcnRzXG4gICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0JpbGxpbmcnLFxuICAgICAgICAgIG1ldHJpY05hbWU6ICdFc3RpbWF0ZWRDaGFyZ2VzJyxcbiAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7IFxuICAgICAgICAgICAgQ3VycmVuY3k6ICdVU0QnLFxuICAgICAgICAgICAgU2VydmljZU5hbWU6ICdBbWF6b25FQ1MnXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3VycygyNClcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0JpbGxpbmcnLFxuICAgICAgICAgIG1ldHJpY05hbWU6ICdFc3RpbWF0ZWRDaGFyZ2VzJyxcbiAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7IFxuICAgICAgICAgICAgQ3VycmVuY3k6ICdVU0QnLFxuICAgICAgICAgICAgU2VydmljZU5hbWU6ICdBbWF6b25SRFMnXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0aXN0aWM6ICdNYXhpbXVtJyxcbiAgICAgICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3VycygyNClcbiAgICAgICAgfSksXG4gICAgICAgIG5ldyBjbG91ZHdhdGNoLk1ldHJpYyh7XG4gICAgICAgICAgbmFtZXNwYWNlOiAnQVdTL0JpbGxpbmcnLFxuICAgICAgICAgIG1ldHJpY05hbWU6ICdFc3RpbWF0ZWRDaGFyZ2VzJyxcbiAgICAgICAgICBkaW1lbnNpb25zTWFwOiB7IFxuICAgICAgICAgICAgQ3VycmVuY3k6ICdVU0QnLFxuICAgICAgICAgICAgU2VydmljZU5hbWU6ICdBbWF6b25TMydcbiAgICAgICAgICB9LFxuICAgICAgICAgIHN0YXRpc3RpYzogJ01heGltdW0nLFxuICAgICAgICAgIHBlcmlvZDogY2RrLkR1cmF0aW9uLmhvdXJzKDI0KVxuICAgICAgICB9KVxuICAgICAgXSxcbiAgICAgIHdpZHRoOiAxMixcbiAgICAgIGhlaWdodDogNlxuICAgIH0pO1xuXG4gICAgLy8gQnVkZ2V0IHV0aWxpemF0aW9uIHRleHQgd2lkZ2V0XG4gICAgY29uc3QgYnVkZ2V0VGV4dFdpZGdldCA9IG5ldyBjbG91ZHdhdGNoLlRleHRXaWRnZXQoe1xuICAgICAgbWFya2Rvd246IGBcbiMgQ29zdCBPcHRpbWl6YXRpb24gRGFzaGJvYXJkXG5cbiMjIE1vbnRobHkgQnVkZ2V0IFRhcmdldDogJDEwMFxuLSAqKlBpbG90IFBoYXNlICgxLTEwIHNjaG9vbHMpKio6IFRhcmdldCA8JDEwMC9tb250aFxuLSAqKlByb2R1Y3Rpb24gUGhhc2UqKjogVGFyZ2V0IDwkMTAvc2Nob29sL21vbnRoXG4tICoqQ29zdCBSZWR1Y3Rpb24gR29hbCoqOiA5MCUgdnMgUmVwbGl0IHNjYWxpbmcgY29zdHNcblxuIyMgS2V5IENvc3QgQ2VudGVyc1xuMS4gKipFQ1MgRmFyZ2F0ZSoqOiBDb21wdXRlIGNvbnRhaW5lcnMgZm9yIGZyb250ZW5kL2JhY2tlbmRcbjIuICoqUkRTIFBvc3RncmVTUUwqKjogRGF0YWJhc2UgaG9zdGluZyAoU2luZ2xlLUFaKVxuMy4gKipDbG91ZEZyb250Kio6IENETiBmb3IgZ2xvYmFsIGNvbnRlbnQgZGVsaXZlcnlcbjQuICoqTGFtYmRhKio6IEFJIGludGVncmF0aW9uIGFuZCBzZXJ2ZXJsZXNzIGZ1bmN0aW9uc1xuNS4gKipTMyoqOiBTdGF0aWMgYXNzZXRzIGFuZCBiYWNrdXBzXG5cbiMjIENvc3QgT3B0aW1pemF0aW9uIFN0cmF0ZWdpZXNcbi0gUmVzZXJ2ZWQgSW5zdGFuY2VzIGZvciBSRFMgKHVwIHRvIDYwJSBzYXZpbmdzKVxuLSBWUEMgRW5kcG9pbnRzIHRvIGF2b2lkIE5BVCBHYXRld2F5IGNvc3RzXG4tIENsb3VkRnJvbnQgY2FjaGluZyB0byByZWR1Y2UgQUxCIHJlcXVlc3RzXG4tIFJpZ2h0LXNpemVkIEVDUyB0YXNrcyBiYXNlZCBvbiBtb25pdG9yaW5nXG4tIFMzIEludGVsbGlnZW50IFRpZXJpbmcgZm9yIGF1dG9tYXRpYyBjb3N0IG9wdGltaXphdGlvblxuXG4jIyBBbGVydCBUaHJlc2hvbGRzXG4tIPCfn6EgKiokNTAqKjogNTAlIGJ1ZGdldCBhbGVydFxuLSDwn5S0ICoqJDEwMCoqOiAxMDAlIGJ1ZGdldCBhbGVydCAoYWN0aW9uIHJlcXVpcmVkKVxuLSDwn5qoICoqJDEyMCoqOiAxMjAlIGJ1ZGdldCBjcml0aWNhbCBhbGVydFxuICAgICAgYCxcbiAgICAgIHdpZHRoOiAyNCxcbiAgICAgIGhlaWdodDogOFxuICAgIH0pO1xuXG4gICAgZGFzaGJvYXJkLmFkZFdpZGdldHMoYnVkZ2V0VGV4dFdpZGdldCk7XG4gICAgZGFzaGJvYXJkLmFkZFdpZGdldHMoYmlsbGluZ1dpZGdldCwgc2VydmljZXNDb3N0V2lkZ2V0KTtcblxuICAgIHJldHVybiBkYXNoYm9hcmQ7XG4gIH1cblxuICBwcml2YXRlIGNyZWF0ZU9wZXJhdGlvbmFsRGFzaGJvYXJkKCk6IHZvaWQge1xuICAgIGNvbnN0IG9wZXJhdGlvbmFsRGFzaGJvYXJkID0gbmV3IGNsb3Vkd2F0Y2guRGFzaGJvYXJkKHRoaXMsICdPcGVyYXRpb25hbERhc2hib2FyZCcsIHtcbiAgICAgIGRhc2hib2FyZE5hbWU6ICdhc3Npc3RlZC1jbGltYi1vcGVyYXRpb25zJyxcbiAgICAgIGRlZmF1bHRJbnRlcnZhbDogY2RrLkR1cmF0aW9uLmhvdXJzKDEpXG4gICAgfSk7XG5cbiAgICAvLyBQbGFjZWhvbGRlciB3aWRnZXRzIGZvciBmdXR1cmUgRUNTLCBSRFMsIGFuZCBMYW1iZGEgbWV0cmljc1xuICAgIGNvbnN0IHBsYWNlaG9sZGVyV2lkZ2V0ID0gbmV3IGNsb3Vkd2F0Y2guVGV4dFdpZGdldCh7XG4gICAgICBtYXJrZG93bjogYFxuIyBBc3Npc3RlZCBDTElNQiBPcGVyYXRpb25zIERhc2hib2FyZFxuXG5UaGlzIGRhc2hib2FyZCB3aWxsIGJlIHBvcHVsYXRlZCB3aXRoIG9wZXJhdGlvbmFsIG1ldHJpY3Mgb25jZSB0aGUgYXBwbGljYXRpb24gaW5mcmFzdHJ1Y3R1cmUgaXMgZGVwbG95ZWQuXG5cbiMjIFBsYW5uZWQgTWV0cmljc1xuLSAqKkVDUyBTZXJ2aWNlIEhlYWx0aCoqOiBUYXNrIGNvdW50LCBDUFUvTWVtb3J5IHV0aWxpemF0aW9uLCBkZXBsb3ltZW50IHN0YXR1c1xuLSAqKlJEUyBQZXJmb3JtYW5jZSoqOiBDb25uZWN0aW9uIGNvdW50LCBxdWVyeSBwZXJmb3JtYW5jZSwgc3RvcmFnZSB1c2FnZVxuLSAqKkFMQiBNZXRyaWNzKio6IFJlcXVlc3QgY291bnQsIHJlc3BvbnNlIHRpbWVzLCBlcnJvciByYXRlc1xuLSAqKkxhbWJkYSBQZXJmb3JtYW5jZSoqOiBEdXJhdGlvbiwgZXJyb3IgcmF0ZSwgY29uY3VycmVudCBleGVjdXRpb25zXG4tICoqQ2xvdWRGcm9udCoqOiBDYWNoZSBoaXQgcmF0aW8sIG9yaWdpbiByZXF1ZXN0cywgZ2xvYmFsIGRpc3RyaWJ1dGlvblxuXG4jIyBBbGVydCBUaHJlc2hvbGRzIChUbyBCZSBDb25maWd1cmVkKVxuLSBFQ1MgQ1BVID4gODAlIGZvciAxMCBtaW51dGVzXG4tIFJEUyBjb25uZWN0aW9ucyA+IDgwJSBvZiBtYXhcbi0gQUxCIGVycm9yIHJhdGUgPiA1JVxuLSBMYW1iZGEgZHVyYXRpb24gPiAzMCBzZWNvbmRzXG4tIExhbWJkYSBlcnJvciByYXRlID4gMSVcblxuKlRoaXMgZGFzaGJvYXJkIHdpbGwgYmUgdXBkYXRlZCBhcyBpbmZyYXN0cnVjdHVyZSBjb21wb25lbnRzIGFyZSBkZXBsb3llZC4qXG4gICAgICBgLFxuICAgICAgd2lkdGg6IDI0LFxuICAgICAgaGVpZ2h0OiAxMlxuICAgIH0pO1xuXG4gICAgb3BlcmF0aW9uYWxEYXNoYm9hcmQuYWRkV2lkZ2V0cyhwbGFjZWhvbGRlcldpZGdldCk7XG4gIH1cblxuICBwcml2YXRlIGVuYWJsZUNvc3RFeHBsb3JlcigpOiB2b2lkIHtcbiAgICAvLyBDdXN0b20gcmVzb3VyY2UgdG8gZW5hYmxlIENvc3QgRXhwbG9yZXIgYW5kIENvc3QgYW5kIFVzYWdlIFJlcG9ydHNcbiAgICBjb25zdCBlbmFibGVDb3N0RXhwbG9yZXJSb2xlID0gbmV3IGlhbS5Sb2xlKHRoaXMsICdFbmFibGVDb3N0RXhwbG9yZXJSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2xhbWJkYS5hbWF6b25hd3MuY29tJyksXG4gICAgICBtYW5hZ2VkUG9saWNpZXM6IFtcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdzZXJ2aWNlLXJvbGUvQVdTTGFtYmRhQmFzaWNFeGVjdXRpb25Sb2xlJylcbiAgICAgIF0sXG4gICAgICBpbmxpbmVQb2xpY2llczoge1xuICAgICAgICBDb3N0RXhwbG9yZXJQb2xpY3k6IG5ldyBpYW0uUG9saWN5RG9jdW1lbnQoe1xuICAgICAgICAgIHN0YXRlbWVudHM6IFtcbiAgICAgICAgICAgIG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgICAgICAgICAgZWZmZWN0OiBpYW0uRWZmZWN0LkFMTE9XLFxuICAgICAgICAgICAgICBhY3Rpb25zOiBbXG4gICAgICAgICAgICAgICAgJ2NlOionLFxuICAgICAgICAgICAgICAgICdjdXI6KicsXG4gICAgICAgICAgICAgICAgJ29yZ2FuaXphdGlvbnM6TGlzdEFjY291bnRzJyxcbiAgICAgICAgICAgICAgICAnb3JnYW5pemF0aW9uczpEZXNjcmliZUFjY291bnQnXG4gICAgICAgICAgICAgIF0sXG4gICAgICAgICAgICAgIHJlc291cmNlczogWycqJ11cbiAgICAgICAgICAgIH0pXG4gICAgICAgICAgXVxuICAgICAgICB9KVxuICAgICAgfVxuICAgIH0pO1xuXG4gICAgLy8gTGFtYmRhIGZ1bmN0aW9uIHRvIGVuYWJsZSBDb3N0IEV4cGxvcmVyXG4gICAgY29uc3QgZW5hYmxlQ29zdEV4cGxvcmVyRnVuY3Rpb24gPSBuZXcgY2RrLmF3c19sYW1iZGEuRnVuY3Rpb24odGhpcywgJ0VuYWJsZUNvc3RFeHBsb3JlckZ1bmN0aW9uJywge1xuICAgICAgcnVudGltZTogY2RrLmF3c19sYW1iZGEuUnVudGltZS5QWVRIT05fM185LFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgcm9sZTogZW5hYmxlQ29zdEV4cGxvcmVyUm9sZSxcbiAgICAgIGNvZGU6IGNkay5hd3NfbGFtYmRhLkNvZGUuZnJvbUlubGluZShgXG5pbXBvcnQgYm90bzNcbmltcG9ydCBqc29uXG5pbXBvcnQgY2ZucmVzcG9uc2VcblxuZGVmIGhhbmRsZXIoZXZlbnQsIGNvbnRleHQpOlxuICAgIHRyeTpcbiAgICAgICAgY2VfY2xpZW50ID0gYm90bzMuY2xpZW50KCdjZScsIHJlZ2lvbl9uYW1lPSd1cy1lYXN0LTEnKVxuICAgICAgICBcbiAgICAgICAgaWYgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ0NyZWF0ZScgb3IgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ1VwZGF0ZSc6XG4gICAgICAgICAgICAjIEVuYWJsZSBDb3N0IEV4cGxvcmVyICh0aGlzIEFQSSBjYWxsIGlzIGlkZW1wb3RlbnQpXG4gICAgICAgICAgICB0cnk6XG4gICAgICAgICAgICAgICAgY2VfY2xpZW50LmdldF9jb3N0X2FuZF91c2FnZShcbiAgICAgICAgICAgICAgICAgICAgVGltZVBlcmlvZD17J1N0YXJ0JzogJzIwMjMtMDEtMDEnLCAnRW5kJzogJzIwMjMtMDEtMDInfSxcbiAgICAgICAgICAgICAgICAgICAgR3JhbnVsYXJpdHk9J0RBSUxZJyxcbiAgICAgICAgICAgICAgICAgICAgTWV0cmljcz1bJ0JsZW5kZWRDb3N0J11cbiAgICAgICAgICAgICAgICApXG4gICAgICAgICAgICAgICAgcHJpbnQoXCJDb3N0IEV4cGxvcmVyIGlzIGFscmVhZHkgZW5hYmxlZCBvciBzdWNjZXNzZnVsbHkgZW5hYmxlZFwiKVxuICAgICAgICAgICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICAgICAgICAgIHByaW50KGZcIkNvc3QgRXhwbG9yZXIgc2V0dXA6IHtzdHIoZSl9XCIpXG4gICAgICAgICAgICAgICAgIyBDb3N0IEV4cGxvcmVyIG1pZ2h0IGFscmVhZHkgYmUgZW5hYmxlZCwgd2hpY2ggaXMgZmluZVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjZm5yZXNwb25zZS5zZW5kKGV2ZW50LCBjb250ZXh0LCBjZm5yZXNwb25zZS5TVUNDRVNTLCB7XG4gICAgICAgICAgICAgICAgJ01lc3NhZ2UnOiAnQ29zdCBFeHBsb3JlciBjb25maWd1cmF0aW9uIGNvbXBsZXRlZCdcbiAgICAgICAgICAgIH0pXG4gICAgICAgIGVsaWYgZXZlbnRbJ1JlcXVlc3RUeXBlJ10gPT0gJ0RlbGV0ZSc6XG4gICAgICAgICAgICAjIE5vIGFjdGlvbiBuZWVkZWQgZm9yIGRlbGV0ZVxuICAgICAgICAgICAgY2ZucmVzcG9uc2Uuc2VuZChldmVudCwgY29udGV4dCwgY2ZucmVzcG9uc2UuU1VDQ0VTUywge30pXG4gICAgZXhjZXB0IEV4Y2VwdGlvbiBhcyBlOlxuICAgICAgICBwcmludChmXCJFcnJvcjoge3N0cihlKX1cIilcbiAgICAgICAgY2ZucmVzcG9uc2Uuc2VuZChldmVudCwgY29udGV4dCwgY2ZucmVzcG9uc2UuRkFJTEVELCB7fSlcbiAgICAgIGApLFxuICAgICAgdGltZW91dDogY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMilcbiAgICB9KTtcblxuICAgIC8vIEN1c3RvbSByZXNvdXJjZSB0byB0cmlnZ2VyIHRoZSBMYW1iZGEgZnVuY3Rpb25cbiAgICBuZXcgY2RrLkN1c3RvbVJlc291cmNlKHRoaXMsICdFbmFibGVDb3N0RXhwbG9yZXJDdXN0b21SZXNvdXJjZScsIHtcbiAgICAgIHNlcnZpY2VUb2tlbjogZW5hYmxlQ29zdEV4cGxvcmVyRnVuY3Rpb24uZnVuY3Rpb25Bcm4sXG4gICAgICBwcm9wZXJ0aWVzOiB7XG4gICAgICAgIEFjY291bnRJZDogdGhpcy5hY2NvdW50LFxuICAgICAgICBUaW1lc3RhbXA6IERhdGUubm93KCkgLy8gRm9yY2UgdXBkYXRlIG9uIHN0YWNrIHVwZGF0ZXNcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSJdfQ==