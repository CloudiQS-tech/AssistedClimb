import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
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
export declare class BillingAlertsStack extends cdk.Stack {
    readonly billingAlertTopic: sns.Topic;
    constructor(scope: Construct, id: string, props?: BillingAlertsStackProps);
    private createBillingAlarms;
    private createBudgets;
    private createCostAnomalyDetection;
}
