"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BillingAlertsStack = void 0;
const cdk = require("aws-cdk-lib");
const sns = require("aws-cdk-lib/aws-sns");
const cloudwatch = require("aws-cdk-lib/aws-cloudwatch");
const budgets = require("aws-cdk-lib/aws-budgets");
const subscriptions = require("aws-cdk-lib/aws-sns-subscriptions");
class BillingAlertsStack extends cdk.Stack {
    constructor(scope, id, props = {}) {
        super(scope, id, props);
        const { alertEmail = 'admin@assistedclimb.education', monthlyBudgetLimit = 100, alertThresholds = [50, 80, 100, 120] } = props;
        // SNS Topic for billing alerts
        this.billingAlertTopic = new sns.Topic(this, 'BillingAlertTopic', {
            topicName: 'assisted-climb-billing-alerts',
            displayName: 'Assisted CLIMB Billing Alerts',
            description: 'SNS topic for AWS billing and cost alerts'
        });
        // Email subscription for alerts
        this.billingAlertTopic.addSubscription(new subscriptions.EmailSubscription(alertEmail));
        // Create CloudWatch billing alarms
        this.createBillingAlarms(alertThresholds);
        // Create AWS Budgets for comprehensive cost tracking
        this.createBudgets(monthlyBudgetLimit, alertThresholds);
        // Create Cost Anomaly Detection
        this.createCostAnomalyDetection();
        // Output important information
        new cdk.CfnOutput(this, 'BillingAlertTopicArn', {
            value: this.billingAlertTopic.topicArn,
            description: 'ARN of the SNS topic for billing alerts',
            exportName: 'AssistedClimbBillingAlertTopicArn'
        });
        new cdk.CfnOutput(this, 'BillingAlertEmail', {
            value: alertEmail,
            description: 'Email address receiving billing alerts'
        });
        new cdk.CfnOutput(this, 'MonthlyBudgetLimit', {
            value: `$${monthlyBudgetLimit}`,
            description: 'Monthly budget limit for cost monitoring'
        });
    }
    createBillingAlarms(thresholds) {
        // CloudWatch billing metric (only available in us-east-1)
        const billingMetric = new cloudwatch.Metric({
            namespace: 'AWS/Billing',
            metricName: 'EstimatedCharges',
            dimensionsMap: {
                Currency: 'USD'
            },
            statistic: 'Maximum',
            period: cdk.Duration.hours(6)
        });
        // Create alarms for $50 and $100 thresholds as specified in task
        const alertAmounts = [50, 100];
        alertAmounts.forEach(amount => {
            new cloudwatch.Alarm(this, `BillingAlarm${amount}USD`, {
                alarmName: `assisted-climb-billing-${amount}usd`,
                alarmDescription: `Billing alarm when estimated charges exceed $${amount}`,
                metric: billingMetric,
                threshold: amount,
                evaluationPeriods: 1,
                comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
            }).addAlarmAction(new cloudwatch.SnsAction(this.billingAlertTopic));
        });
        // Additional threshold-based alarms
        thresholds.forEach((threshold, index) => {
            const amount = (100 * threshold) / 100; // Convert percentage to dollar amount based on $100 budget
            if (!alertAmounts.includes(amount)) {
                new cloudwatch.Alarm(this, `BillingAlarmThreshold${threshold}Percent`, {
                    alarmName: `assisted-climb-billing-${threshold}percent`,
                    alarmDescription: `Billing alarm at ${threshold}% of monthly budget ($${amount})`,
                    metric: billingMetric,
                    threshold: amount,
                    evaluationPeriods: 1,
                    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
                    treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING
                }).addAlarmAction(new cloudwatch.SnsAction(this.billingAlertTopic));
            }
        });
    }
    createBudgets(monthlyLimit, thresholds) {
        // Create monthly budget with cost and usage tracking
        new budgets.CfnBudget(this, 'MonthlyBudget', {
            budget: {
                budgetName: 'assisted-climb-monthly-budget',
                budgetType: 'COST',
                timeUnit: 'MONTHLY',
                budgetLimit: {
                    amount: monthlyLimit,
                    unit: 'USD'
                },
                costFilters: {
                    // Filter to only track costs for this project
                    TagKey: ['Project'],
                    TagValue: ['Assisted-CLIMB']
                },
                calculatedSpend: {
                    actualSpend: {
                        amount: 0,
                        unit: 'USD'
                    }
                }
            },
            notificationsWithSubscribers: thresholds.map(threshold => ({
                notification: {
                    notificationType: 'ACTUAL',
                    comparisonOperator: 'GREATER_THAN',
                    threshold: threshold,
                    thresholdType: 'PERCENTAGE'
                },
                subscribers: [{
                        subscriptionType: 'SNS',
                        address: this.billingAlertTopic.topicArn
                    }]
            }))
        });
        // Create forecasted budget for proactive monitoring
        new budgets.CfnBudget(this, 'ForecastedBudget', {
            budget: {
                budgetName: 'assisted-climb-forecasted-budget',
                budgetType: 'COST',
                timeUnit: 'MONTHLY',
                budgetLimit: {
                    amount: monthlyLimit,
                    unit: 'USD'
                },
                costFilters: {
                    TagKey: ['Project'],
                    TagValue: ['Assisted-CLIMB']
                }
            },
            notificationsWithSubscribers: [{
                    notification: {
                        notificationType: 'FORECASTED',
                        comparisonOperator: 'GREATER_THAN',
                        threshold: 80,
                        thresholdType: 'PERCENTAGE'
                    },
                    subscribers: [{
                            subscriptionType: 'SNS',
                            address: this.billingAlertTopic.topicArn
                        }]
                }]
        });
        // Create usage-based budget for ECS and RDS
        new budgets.CfnBudget(this, 'UsageBudget', {
            budget: {
                budgetName: 'assisted-climb-usage-budget',
                budgetType: 'USAGE',
                timeUnit: 'MONTHLY',
                budgetLimit: {
                    amount: 1000,
                    unit: 'Hours'
                },
                costFilters: {
                    Service: ['Amazon Elastic Container Service', 'Amazon Relational Database Service']
                }
            },
            notificationsWithSubscribers: [{
                    notification: {
                        notificationType: 'ACTUAL',
                        comparisonOperator: 'GREATER_THAN',
                        threshold: 80,
                        thresholdType: 'PERCENTAGE'
                    },
                    subscribers: [{
                            subscriptionType: 'SNS',
                            address: this.billingAlertTopic.topicArn
                        }]
                }]
        });
    }
    createCostAnomalyDetection() {
        // Cost anomaly detection for unusual spending patterns
        const costAnomalyDetector = new cdk.aws_ce.CfnAnomalyDetector(this, 'CostAnomalyDetector', {
            anomalyDetector: {
                detectorName: 'assisted-climb-cost-anomaly-detector',
                monitorType: 'DIMENSIONAL',
                specification: JSON.stringify({
                    Dimension: 'SERVICE',
                    MatchOptions: ['EQUALS'],
                    Values: [
                        'Amazon Elastic Container Service',
                        'Amazon Relational Database Service',
                        'Amazon Simple Storage Service',
                        'Amazon CloudFront',
                        'AWS Lambda'
                    ]
                })
            }
        });
        // Subscribe to anomaly alerts
        new cdk.aws_ce.CfnAnomalySubscription(this, 'CostAnomalySubscription', {
            subscription: {
                subscriptionName: 'assisted-climb-anomaly-alerts',
                frequency: 'DAILY',
                monitorArnList: [costAnomalyDetector.attrAnomalyDetectorArn],
                subscribers: [{
                        type: 'SNS',
                        address: this.billingAlertTopic.topicArn
                    }],
                threshold: 50,
                thresholdExpression: 'GREATER_THAN_OR_EQUAL_TO'
            }
        });
    }
}
exports.BillingAlertsStack = BillingAlertsStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmlsbGluZy1hbGVydHMtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJiaWxsaW5nLWFsZXJ0cy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFDbkMsMkNBQTJDO0FBQzNDLHlEQUF5RDtBQUN6RCxtREFBbUQ7QUFDbkQsbUVBQW1FO0FBd0JuRSxNQUFhLGtCQUFtQixTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBRy9DLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsUUFBaUMsRUFBRTtRQUMzRSxLQUFLLENBQUMsS0FBSyxFQUFFLEVBQUUsRUFBRSxLQUFLLENBQUMsQ0FBQztRQUV4QixNQUFNLEVBQ0osVUFBVSxHQUFHLCtCQUErQixFQUM1QyxrQkFBa0IsR0FBRyxHQUFHLEVBQ3hCLGVBQWUsR0FBRyxDQUFDLEVBQUUsRUFBRSxFQUFFLEVBQUUsR0FBRyxFQUFFLEdBQUcsQ0FBQyxFQUNyQyxHQUFHLEtBQUssQ0FBQztRQUVWLCtCQUErQjtRQUMvQixJQUFJLENBQUMsaUJBQWlCLEdBQUcsSUFBSSxHQUFHLENBQUMsS0FBSyxDQUFDLElBQUksRUFBRSxtQkFBbUIsRUFBRTtZQUNoRSxTQUFTLEVBQUUsK0JBQStCO1lBQzFDLFdBQVcsRUFBRSwrQkFBK0I7WUFDNUMsV0FBVyxFQUFFLDJDQUEyQztTQUN6RCxDQUFDLENBQUM7UUFFSCxnQ0FBZ0M7UUFDaEMsSUFBSSxDQUFDLGlCQUFpQixDQUFDLGVBQWUsQ0FDcEMsSUFBSSxhQUFhLENBQUMsaUJBQWlCLENBQUMsVUFBVSxDQUFDLENBQ2hELENBQUM7UUFFRixtQ0FBbUM7UUFDbkMsSUFBSSxDQUFDLG1CQUFtQixDQUFDLGVBQWUsQ0FBQyxDQUFDO1FBRTFDLHFEQUFxRDtRQUNyRCxJQUFJLENBQUMsYUFBYSxDQUFDLGtCQUFrQixFQUFFLGVBQWUsQ0FBQyxDQUFDO1FBRXhELGdDQUFnQztRQUNoQyxJQUFJLENBQUMsMEJBQTBCLEVBQUUsQ0FBQztR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QUMsaUJBQWlCLENBQUMsUUFBUTt5QkFDekMsQ0FBQztpQkFDSCxDQUFDO1NBQ0gsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztJQUVPLDBCQUEwQjtRQUNoQyx1REFBdUQ7UUFDdkQsTUFBTSxtQkFBbUIsR0FBRyxJQUFJLEdBQUcsQ0FBQyxNQUFNLENBQUMsa0JBQWtCLENBQUMsSUFBSSxFQUFFLHFCQUFxQixFQUFFO1lBQ3pGLGVBQWUsRUFBRTtnQkFDZixZQUFZLEVBQUUsc0NBQXNDO2dCQUNwRCxXQUFXLEVBQUUsYUFBYTtnQkFDMUIsYUFBYSxFQUFFLElBQUksQ0FBQyxTQUFTLENBQUM7b0JBQzVCLFNBQVMsRUFBRSxTQUFTO29CQUNwQixZQUFZLEVBQUUsQ0FBQyxRQUFRLENBQUM7b0JBQ3hCLE1BQU0sRUFBRTt3QkFDTixrQ0FBa0M7d0JBQ2xDLG9DQUFvQzt3QkFDcEMsK0JBQStCO3dCQUMvQixtQkFBbUI7d0JBQ25CLFlBQVk7cUJBQ2I7aUJBQ0YsQ0FBQzthQUNIO1NBQ0YsQ0FBQyxDQUFDO1FBRUgsOEJBQThCO1FBQzlCLElBQUksR0FBRyxDQUFDLE1BQU0sQ0FBQyxzQkFBc0IsQ0FBQyxJQUFJLEVBQUUseUJBQXlCLEVBQUU7WUFDckUsWUFBWSxFQUFFO2dCQUNaLGdCQUFnQixFQUFFLCtCQUErQjtnQkFDakQsU0FBUyxFQUFFLE9BQU87Z0JBQ2xCLGNBQWMsRUFBRSxDQUFDLG1CQUFtQixDQUFDLHNCQUFzQixDQUFDO2dCQUM1RCxXQUFXLEVBQUUsQ0FBQzt3QkFDWixJQUFJLEVBQUUsS0FBSzt3QkFDWCxPQUFPLEVBQUUsSUFBSSxDQUFDLGlCQUFpQixDQUFDLFFBQVE7cUJBQ3pDLENBQUM7Z0JBQ0YsU0FBUyxFQUFFLEVBQUU7Z0JBQ2IsbUJBQW1CLEVBQUUsMEJBQTBCO2FBQ2hEO1NBQ0YsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBdE9ELGdEQXNPQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBzbnMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXNucyc7XG5pbXBvcnQgKiBhcyBjbG91ZHdhdGNoIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jbG91ZHdhdGNoJztcbmltcG9ydCAqIGFzIGJ1ZGdldHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLWJ1ZGdldHMnO1xuaW1wb3J0ICogYXMgc3Vic2NyaXB0aW9ucyBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc25zLXN1YnNjcmlwdGlvbnMnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5cbmV4cG9ydCBpbnRlcmZhY2UgQmlsbGluZ0FsZXJ0c1N0YWNrUHJvcHMgZXh0ZW5kcyBjZGsuU3RhY2tQcm9wcyB7XG4gIC8qKlxuICAgKiBFbWFpbCBhZGRyZXNzIGZvciBiaWxsaW5nIGFsZXJ0c1xuICAgKiBAZGVmYXVsdCAnYWRtaW5AYXNzaXN0ZWRjbGltYi5lZHVjYXRpb24nXG4gICAqL1xuICBhbGVydEVtYWlsPzogc3RyaW5nO1xuICBcbiAgLyoqXG4gICAqIE1vbnRobHkgYnVkZ2V0IGxpbWl0IGluIFVTRFxuICAgKiBAZGVmYXVsdCAxMDBcbiAgICovXG4gIG1vbnRobHlCdWRnZXRMaW1pdD86IG51bWJlcjtcbiAgXG4gIC8qKlxuICAgKiBBbGVydCB0aHJlc2hvbGRzIGFzIHBlcmNlbnRhZ2VzIG9mIGJ1ZGdldFxuICAgKiBAZGVmYXVsdCBbNTAsIDgwLCAxMDAsIDEyMF1cbiAgICovXG4gIGFsZXJ0VGhyZXNob2xkcz86IG51bWJlcltdO1xufVxuXG5leHBvcnQgY2xhc3MgQmlsbGluZ0FsZXJ0c1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgcHVibGljIHJlYWRvbmx5IGJpbGxpbmdBbGVydFRvcGljOiBzbnMuVG9waWM7XG4gIFxuICBjb25zdHJ1Y3RvcihzY29wZTogQ29uc3RydWN0LCBpZDogc3RyaW5nLCBwcm9wczogQmlsbGluZ0FsZXJ0c1N0YWNrUHJvcHMgPSB7fSkge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgY29uc3Qge1xuICAgICAgYWxlcnRFbWFpbCA9ICdhZG1pbkBhc3Npc3RlZGNsaW1iLmVkdWNhdGlvbicsXG4gICAgICBtb250aGx5QnVkZ2V0TGltaXQgPSAxMDAsXG4gICAgICBhbGVydFRocmVzaG9sZHMgPSBbNTAsIDgwLCAxMDAsIDEyMF1cbiAgICB9ID0gcHJvcHM7XG5cbiAgICAvLyBTTlMgVG9waWMgZm9yIGJpbGxpbmcgYWxlcnRzXG4gICAgdGhpcy5iaWxsaW5nQWxlcnRUb3BpYyA9IG5ldyBzbnMuVG9waWModGhpcywgJ0JpbGxpbmdBbGVydFRvcGljJywge1xuICAgICAgdG9waWNOYW1lOiAnYXNzaXN0ZWQtY2xpbWItYmlsbGluZy1hbGVydHMnLFxuICAgICAgZGlzcGxheU5hbWU6ICdBc3Npc3RlZCBDTElNQiBCaWxsaW5nIEFsZXJ0cycsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NOUyB0b3BpYyBmb3IgQVdTIGJpbGxpbmcgYW5kIGNvc3QgYWxlcnRzJ1xuICAgIH0pO1xuXG4gICAgLy8gRW1haWwgc3Vic2NyaXB0aW9uIGZvciBhbGVydHNcbiAgICB0aGlzLmJpbGxpbmdBbGVydFRvcGljLmFkZFN1YnNjcmlwdGlvbihcbiAgICAgIG5ldyBzdWJzY3JpcHRpb25zLkVtYWlsU3Vic2NyaXB0aW9uKGFsZXJ0RW1haWwpXG4gICAgKTtcblxuICAgIC8vIENyZWF0ZSBDbG91ZFdhdGNoIGJpbGxpbmcgYWxhcm1zXG4gICAgdGhpcy5jcmVhdGVCaWxsaW5nQWxhcm1zKGFsZXJ0VGhyZXNob2xkcyk7XG5cbiAgICAvLyBDcmVhdGUgQVdTIEJ1ZGdldHMgZm9yIGNvbXByZWhlbnNpdmUgY29zdCB0cmFja2luZ1xuICAgIHRoaXMuY3JlYXRlQnVkZ2V0cyhtb250aGx5QnVkZ2V0TGltaXQsIGFsZXJ0VGhyZXNob2xkcyk7XG5cbiAgICAvLyBDcmVhdGUgQ29zdCBBbm9tYWx5IERldGVjdGlvblxuICAgIHRoaXMuY3JlYXRlQ29zdEFub21hbHlEZXRlY3Rpb24oKTtcblxuICAgIC8vIE91dHB1dCBpbXBvcnRhbnQgaW5mb3JtYXRpb25cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ0FsZXJ0VG9waWNBcm4nLCB7XG4gICAgICB2YWx1ZTogdGhpcy5iaWxsaW5nQWxlcnRUb3BpYy50b3BpY0FybixcbiAgICAgIGRlc2NyaXB0aW9uOiAnQVJOIG9mIHRoZSBTTlMgdG9waWMgZm9yIGJpbGxpbmcgYWxlcnRzJyxcbiAgICAgIGV4cG9ydE5hbWU6ICdBc3Npc3RlZENsaW1iQmlsbGluZ0FsZXJ0VG9waWNBcm4nXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnQmlsbGluZ0FsZXJ0RW1haWwnLCB7XG4gICAgICB2YWx1ZTogYWxlcnRFbWFpbCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnRW1haWwgYWRkcmVzcyByZWNlaXZpbmcgYmlsbGluZyBhbGVydHMnXG4gICAgfSk7XG5cbiAgICBuZXcgY2RrLkNmbk91dHB1dCh0aGlzLCAnTW9udGhseUJ1ZGdldExpbWl0Jywge1xuICAgICAgdmFsdWU6IGAkJHttb250aGx5QnVkZ2V0TGltaXR9YCxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTW9udGhseSBidWRnZXQgbGltaXQgZm9yIGNvc3QgbW9uaXRvcmluZydcbiAgICB9KTtcbiAgfVxuXG4gIHByaXZhdGUgY3JlYXRlQmlsbGluZ0FsYXJtcyh0aHJlc2hvbGRzOiBudW1iZXJbXSk6IHZvaWQge1xuICAgIC8vIENsb3VkV2F0Y2ggYmlsbGluZyBtZXRyaWMgKG9ubHkgYXZhaWxhYmxlIGluIHVzLWVhc3QtMSlcbiAgICBjb25zdCBiaWxsaW5nTWV0cmljID0gbmV3IGNsb3Vkd2F0Y2guTWV0cmljKHtcbiAgICAgIG5hbWVzcGFjZTogJ0FXUy9CaWxsaW5nJyxcbiAgICAgIG1ldHJpY05hbWU6ICdFc3RpbWF0ZWRDaGFyZ2VzJyxcbiAgICAgIGRpbWVuc2lvbnNNYXA6IHtcbiAgICAgICAgQ3VycmVuY3k6ICdVU0QnXG4gICAgICB9LFxuICAgICAgc3RhdGlzdGljOiAnTWF4aW11bScsXG4gICAgICBwZXJpb2Q6IGNkay5EdXJhdGlvbi5ob3Vycyg2KVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIGFsYXJtcyBmb3IgJDUwIGFuZCAkMTAwIHRocmVzaG9sZHMgYXMgc3BlY2lmaWVkIGluIHRhc2tcbiAgICBjb25zdCBhbGVydEFtb3VudHMgPSBbNTAsIDEwMF07XG4gICAgXG4gICAgYWxlcnRBbW91bnRzLmZvckVhY2goYW1vdW50ID0+IHtcbiAgICAgIG5ldyBjbG91ZHdhdGNoLkFsYXJtKHRoaXMsIGBCaWxsaW5nQWxhcm0ke2Ftb3VudH1VU0RgLCB7XG4gICAgICAgIGFsYXJtTmFtZTogYGFzc2lzdGVkLWNsaW1iLWJpbGxpbmctJHthbW91bnR9dXNkYCxcbiAgICAgICAgYWxhcm1EZXNjcmlwdGlvbjogYEJpbGxpbmcgYWxhcm0gd2hlbiBlc3RpbWF0ZWQgY2hhcmdlcyBleGNlZWQgJCR7YW1vdW50fWAsXG4gICAgICAgIG1ldHJpYzogYmlsbGluZ01ldHJpYyxcbiAgICAgICAgdGhyZXNob2xkOiBhbW91bnQsXG4gICAgICAgIGV2YWx1YXRpb25QZXJpb2RzOiAxLFxuICAgICAgICBjb21wYXJpc29uT3BlcmF0b3I6IGNsb3Vkd2F0Y2guQ29tcGFyaXNvbk9wZXJhdG9yLkdSRUFURVJfVEhBTl9USFJFU0hPTEQsXG4gICAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5OT1RfQlJFQUNISU5HXG4gICAgICB9KS5hZGRBbGFybUFjdGlvbihcbiAgICAgICAgbmV3IGNsb3Vkd2F0Y2guU25zQWN0aW9uKHRoaXMuYmlsbGluZ0FsZXJ0VG9waWMpXG4gICAgICApO1xuICAgIH0pO1xuXG4gICAgLy8gQWRkaXRpb25hbCB0aHJlc2hvbGQtYmFzZWQgYWxhcm1zXG4gICAgdGhyZXNob2xkcy5mb3JFYWNoKCh0aHJlc2hvbGQsIGluZGV4KSA9PiB7XG4gICAgICBjb25zdCBhbW91bnQgPSAoMTAwICogdGhyZXNob2xkKSAvIDEwMDsgLy8gQ29udmVydCBwZXJjZW50YWdlIHRvIGRvbGxhciBhbW91bnQgYmFzZWQgb24gJDEwMCBidWRnZXRcbiAgICAgIFxuICAgICAgaWYgKCFhbGVydEFtb3VudHMuaW5jbHVkZXMoYW1vdW50KSkge1xuICAgICAgICBuZXcgY2xvdWR3YXRjaC5BbGFybSh0aGlzLCBgQmlsbGluZ0FsYXJtVGhyZXNob2xkJHt0aHJlc2hvbGR9UGVyY2VudGAsIHtcbiAgICAgICAgICBhbGFybU5hbWU6IGBhc3Npc3RlZC1jbGltYi1iaWxsaW5nLSR7dGhyZXNob2xkfXBlcmNlbnRgLFxuICAgICAgICAgIGFsYXJtRGVzY3JpcHRpb246IGBCaWxsaW5nIGFsYXJtIGF0ICR7dGhyZXNob2xkfSUgb2YgbW9udGhseSBidWRnZXQgKCQke2Ftb3VudH0pYCxcbiAgICAgICAgICBtZXRyaWM6IGJpbGxpbmdNZXRyaWMsXG4gICAgICAgICAgdGhyZXNob2xkOiBhbW91bnQsXG4gICAgICAgICAgZXZhbHVhdGlvblBlcmlvZHM6IDEsXG4gICAgICAgICAgY29tcGFyaXNvbk9wZXJhdG9yOiBjbG91ZHdhdGNoLkNvbXBhcmlzb25PcGVyYXRvci5HUkVBVEVSX1RIQU5fVEhSRVNIT0xELFxuICAgICAgICAgIHRyZWF0TWlzc2luZ0RhdGE6IGNsb3Vkd2F0Y2guVHJlYXRNaXNzaW5nRGF0YS5OT1RfQlJFQUNISU5HXG4gICAgICAgIH0pLmFkZEFsYXJtQWN0aW9uKFxuICAgICAgICAgIG5ldyBjbG91ZHdhdGNoLlNuc0FjdGlvbih0aGlzLmJpbGxpbmdBbGVydFRvcGljKVxuICAgICAgICApO1xuICAgICAgfVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVCdWRnZXRzKG1vbnRobHlMaW1pdDogbnVtYmVyLCB0aHJlc2hvbGRzOiBudW1iZXJbXSk6IHZvaWQge1xuICAgIC8vIENyZWF0ZSBtb250aGx5IGJ1ZGdldCB3aXRoIGNvc3QgYW5kIHVzYWdlIHRyYWNraW5nXG4gICAgbmV3IGJ1ZGdldHMuQ2ZuQnVkZ2V0KHRoaXMsICdNb250aGx5QnVkZ2V0Jywge1xuICAgICAgYnVkZ2V0OiB7XG4gICAgICAgIGJ1ZGdldE5hbWU6ICdhc3Npc3RlZC1jbGltYi1tb250aGx5LWJ1ZGdldCcsXG4gICAgICAgIGJ1ZGdldFR5cGU6ICdDT1NUJyxcbiAgICAgICAgdGltZVVuaXQ6ICdNT05USExZJyxcbiAgICAgICAgYnVkZ2V0TGltaXQ6IHtcbiAgICAgICAgICBhbW91bnQ6IG1vbnRobHlMaW1pdCxcbiAgICAgICAgICB1bml0OiAnVVNEJ1xuICAgICAgICB9LFxuICAgICAgICBjb3N0RmlsdGVyczoge1xuICAgICAgICAgIC8vIEZpbHRlciB0byBvbmx5IHRyYWNrIGNvc3RzIGZvciB0aGlzIHByb2plY3RcbiAgICAgICAgICBUYWdLZXk6IFsnUHJvamVjdCddLFxuICAgICAgICAgIFRhZ1ZhbHVlOiBbJ0Fzc2lzdGVkLUNMSU1CJ11cbiAgICAgICAgfSxcbiAgICAgICAgY2FsY3VsYXRlZFNwZW5kOiB7XG4gICAgICAgICAgYWN0dWFsU3BlbmQ6IHtcbiAgICAgICAgICAgIGFtb3VudDogMCxcbiAgICAgICAgICAgIHVuaXQ6ICdVU0QnXG4gICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgbm90aWZpY2F0aW9uc1dpdGhTdWJzY3JpYmVyczogdGhyZXNob2xkcy5tYXAodGhyZXNob2xkID0+ICh7XG4gICAgICAgIG5vdGlmaWNhdGlvbjoge1xuICAgICAgICAgIG5vdGlmaWNhdGlvblR5cGU6ICdBQ1RVQUwnLFxuICAgICAgICAgIGNvbXBhcmlzb25PcGVyYXRvcjogJ0dSRUFURVJfVEhBTicsXG4gICAgICAgICAgdGhyZXNob2xkOiB0aHJlc2hvbGQsXG4gICAgICAgICAgdGhyZXNob2xkVHlwZTogJ1BFUkNFTlRBR0UnXG4gICAgICAgIH0sXG4gICAgICAgIHN1YnNjcmliZXJzOiBbe1xuICAgICAgICAgIHN1YnNjcmlwdGlvblR5cGU6ICdTTlMnLFxuICAgICAgICAgIGFkZHJlc3M6IHRoaXMuYmlsbGluZ0FsZXJ0VG9waWMudG9waWNBcm5cbiAgICAgICAgfV1cbiAgICAgIH0pKVxuICAgIH0pO1xuXG4gICAgLy8gQ3JlYXRlIGZvcmVjYXN0ZWQgYnVkZ2V0IGZvciBwcm9hY3RpdmUgbW9uaXRvcmluZ1xuICAgIG5ldyBidWRnZXRzLkNmbkJ1ZGdldCh0aGlzLCAnRm9yZWNhc3RlZEJ1ZGdldCcsIHtcbiAgICAgIGJ1ZGdldDoge1xuICAgICAgICBidWRnZXROYW1lOiAnYXNzaXN0ZWQtY2xpbWItZm9yZWNhc3RlZC1idWRnZXQnLFxuICAgICAgICBidWRnZXRUeXBlOiAnQ09TVCcsXG4gICAgICAgIHRpbWVVbml0OiAnTU9OVEhMWScsXG4gICAgICAgIGJ1ZGdldExpbWl0OiB7XG4gICAgICAgICAgYW1vdW50OiBtb250aGx5TGltaXQsXG4gICAgICAgICAgdW5pdDogJ1VTRCdcbiAgICAgICAgfSxcbiAgICAgICAgY29zdEZpbHRlcnM6IHtcbiAgICAgICAgICBUYWdLZXk6IFsnUHJvamVjdCddLFxuICAgICAgICAgIFRhZ1ZhbHVlOiBbJ0Fzc2lzdGVkLUNMSU1CJ11cbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIG5vdGlmaWNhdGlvbnNXaXRoU3Vic2NyaWJlcnM6IFt7XG4gICAgICAgIG5vdGlmaWNhdGlvbjoge1xuICAgICAgICAgIG5vdGlmaWNhdGlvblR5cGU6ICdGT1JFQ0FTVEVEJyxcbiAgICAgICAgICBjb21wYXJpc29uT3BlcmF0b3I6ICdHUkVBVEVSX1RIQU4nLFxuICAgICAgICAgIHRocmVzaG9sZDogODAsIC8vIEFsZXJ0IHdoZW4gZm9yZWNhc3QgZXhjZWVkcyA4MCUgb2YgYnVkZ2V0XG4gICAgICAgICAgdGhyZXNob2xkVHlwZTogJ1BFUkNFTlRBR0UnXG4gICAgICAgIH0sXG4gICAgICAgIHN1YnNjcmliZXJzOiBbe1xuICAgICAgICAgIHN1YnNjcmlwdGlvblR5cGU6ICdTTlMnLFxuICAgICAgICAgIGFkZHJlc3M6IHRoaXMuYmlsbGluZ0FsZXJ0VG9waWMudG9waWNBcm5cbiAgICAgICAgfV1cbiAgICAgIH1dXG4gICAgfSk7XG5cbiAgICAvLyBDcmVhdGUgdXNhZ2UtYmFzZWQgYnVkZ2V0IGZvciBFQ1MgYW5kIFJEU1xuICAgIG5ldyBidWRnZXRzLkNmbkJ1ZGdldCh0aGlzLCAnVXNhZ2VCdWRnZXQnLCB7XG4gICAgICBidWRnZXQ6IHtcbiAgICAgICAgYnVkZ2V0TmFtZTogJ2Fzc2lzdGVkLWNsaW1iLXVzYWdlLWJ1ZGdldCcsXG4gICAgICAgIGJ1ZGdldFR5cGU6ICdVU0FHRScsXG4gICAgICAgIHRpbWVVbml0OiAnTU9OVEhMWScsXG4gICAgICAgIGJ1ZGdldExpbWl0OiB7XG4gICAgICAgICAgYW1vdW50OiAxMDAwLCAvLyAxMDAwIGhvdXJzIG9mIGNvbXB1dGUgdGltZVxuICAgICAgICAgIHVuaXQ6ICdIb3VycydcbiAgICAgICAgfSxcbiAgICAgICAgY29zdEZpbHRlcnM6IHtcbiAgICAgICAgICBTZXJ2aWNlOiBbJ0FtYXpvbiBFbGFzdGljIENvbnRhaW5lciBTZXJ2aWNlJywgJ0FtYXpvbiBSZWxhdGlvbmFsIERhdGFiYXNlIFNlcnZpY2UnXVxuICAgICAgICB9XG4gICAgICB9LFxuICAgICAgbm90aWZpY2F0aW9uc1dpdGhTdWJzY3JpYmVyczogW3tcbiAgICAgICAgbm90aWZpY2F0aW9uOiB7XG4gICAgICAgICAgbm90aWZpY2F0aW9uVHlwZTogJ0FDVFVBTCcsXG4gICAgICAgICAgY29tcGFyaXNvbk9wZXJhdG9yOiAnR1JFQVRFUl9USEFOJyxcbiAgICAgICAgICB0aHJlc2hvbGQ6IDgwLFxuICAgICAgICAgIHRocmVzaG9sZFR5cGU6ICdQRVJDRU5UQUdFJ1xuICAgICAgICB9LFxuICAgICAgICBzdWJzY3JpYmVyczogW3tcbiAgICAgICAgICBzdWJzY3JpcHRpb25UeXBlOiAnU05TJyxcbiAgICAgICAgICBhZGRyZXNzOiB0aGlzLmJpbGxpbmdBbGVydFRvcGljLnRvcGljQXJuXG4gICAgICAgIH1dXG4gICAgICB9XVxuICAgIH0pO1xuICB9XG5cbiAgcHJpdmF0ZSBjcmVhdGVDb3N0QW5vbWFseURldGVjdGlvbigpOiB2b2lkIHtcbiAgICAvLyBDb3N0IGFub21hbHkgZGV0ZWN0aW9uIGZvciB1bnVzdWFsIHNwZW5kaW5nIHBhdHRlcm5zXG4gICAgY29uc3QgY29zdEFub21hbHlEZXRlY3RvciA9IG5ldyBjZGsuYXdzX2NlLkNmbkFub21hbHlEZXRlY3Rvcih0aGlzLCAnQ29zdEFub21hbHlEZXRlY3RvcicsIHtcbiAgICAgIGFub21hbHlEZXRlY3Rvcjoge1xuICAgICAgICBkZXRlY3Rvck5hbWU6ICdhc3Npc3RlZC1jbGltYi1jb3N0LWFub21hbHktZGV0ZWN0b3InLFxuICAgICAgICBtb25pdG9yVHlwZTogJ0RJTUVOU0lPTkFMJyxcbiAgICAgICAgc3BlY2lmaWNhdGlvbjogSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgIERpbWVuc2lvbjogJ1NFUlZJQ0UnLFxuICAgICAgICAgIE1hdGNoT3B0aW9uczogWydFUVVBTFMnXSxcbiAgICAgICAgICBWYWx1ZXM6IFtcbiAgICAgICAgICAgICdBbWF6b24gRWxhc3RpYyBDb250YWluZXIgU2VydmljZScsXG4gICAgICAgICAgICAnQW1hem9uIFJlbGF0aW9uYWwgRGF0YWJhc2UgU2VydmljZScsXG4gICAgICAgICAgICAnQW1hem9uIFNpbXBsZSBTdG9yYWdlIFNlcnZpY2UnLFxuICAgICAgICAgICAgJ0FtYXpvbiBDbG91ZEZyb250JyxcbiAgICAgICAgICAgICdBV1MgTGFtYmRhJ1xuICAgICAgICAgIF1cbiAgICAgICAgfSlcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vIFN1YnNjcmliZSB0byBhbm9tYWx5IGFsZXJ0c1xuICAgIG5ldyBjZGsuYXdzX2NlLkNmbkFub21hbHlTdWJzY3JpcHRpb24odGhpcywgJ0Nvc3RBbm9tYWx5U3Vic2NyaXB0aW9uJywge1xuICAgICAgc3Vic2NyaXB0aW9uOiB7XG4gICAgICAgIHN1YnNjcmlwdGlvbk5hbWU6ICdhc3Npc3RlZC1jbGltYi1hbm9tYWx5LWFsZXJ0cycsXG4gICAgICAgIGZyZXF1ZW5jeTogJ0RBSUxZJyxcbiAgICAgICAgbW9uaXRvckFybkxpc3Q6IFtjb3N0QW5vbWFseURldGVjdG9yLmF0dHJBbm9tYWx5RGV0ZWN0b3JBcm5dLFxuICAgICAgICBzdWJzY3JpYmVyczogW3tcbiAgICAgICAgICB0eXBlOiAnU05TJyxcbiAgICAgICAgICBhZGRyZXNzOiB0aGlzLmJpbGxpbmdBbGVydFRvcGljLnRvcGljQXJuXG4gICAgICAgIH1dLFxuICAgICAgICB0aHJlc2hvbGQ6IDUwLCAvLyBBbGVydCBvbiBhbm9tYWxpZXMgPiAkNTBcbiAgICAgICAgdGhyZXNob2xkRXhwcmVzc2lvbjogJ0dSRUFURVJfVEhBTl9PUl9FUVVBTF9UTydcbiAgICAgIH1cbiAgICB9KTtcbiAgfVxufSJdfQ==