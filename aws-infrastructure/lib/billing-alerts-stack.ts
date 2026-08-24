import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BillingAlertsStackProps extends cdk.StackProps {
  /**
   * Email address for billing alerts
   * @default 'admin@assistedclimb.education'
   */
  alertEmail?: string;
  
  /**
   * Monthly budget limit in USD
   * @default 100
   */
  monthlyBudgetLimit?: number;
  
  /**
   * Alert thresholds as percentages of budget
   * @default [50, 80, 100, 120]
   */
  alertThresholds?: number[];
}

export class BillingAlertsStack extends cdk.Stack {
  public readonly billingAlertTopic: sns.Topic;
  
  constructor(scope: Construct, id: string, props: BillingAlertsStackProps = {}) {
    super(scope, id, props);

    const {
      alertEmail = 'admin@assistedclimb.education',
      monthlyBudgetLimit = 100,
      alertThresholds = [50, 80, 100, 120]
    } = props;

    // SNS Topic for billing alerts
    this.billingAlertTopic = new sns.Topic(this, 'BillingAlertTopic', {
      topicName: 'assisted-climb-billing-alerts',
      displayName: 'Assisted CLIMB Billing Alerts',
      description: 'SNS topic for AWS billing and cost alerts'
    });

    // Email subscription for alerts
    this.billingAlertTopic.addSubscription(
      new subscriptions.EmailSubscription(alertEmail)
    );

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

  private createBillingAlarms(thresholds: number[]): void {
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
      }).addAlarmAction(
        new cloudwatch.SnsAction(this.billingAlertTopic)
      );
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
        }).addAlarmAction(
          new cloudwatch.SnsAction(this.billingAlertTopic)
        );
      }
    });
  }

  private createBudgets(monthlyLimit: number, thresholds: number[]): void {
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
          threshold: 80, // Alert when forecast exceeds 80% of budget
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
          amount: 1000, // 1000 hours of compute time
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

  private createCostAnomalyDetection(): void {
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
        threshold: 50, // Alert on anomalies > $50
        thresholdExpression: 'GREATER_THAN_OR_EQUAL_TO'
      }
    });
  }
}