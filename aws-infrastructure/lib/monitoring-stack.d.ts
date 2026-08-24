import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
export interface MonitoringStackProps extends cdk.StackProps {
    /**
     * Email address for operational alerts
     * @default 'ops@assistedclimb.education'
     */
    alertEmail?: string;
}
export declare class MonitoringStack extends cdk.Stack {
    readonly operationalAlertTopic: sns.Topic;
    readonly costDashboard: cloudwatch.Dashboard;
    constructor(scope: Construct, id: string, props?: MonitoringStackProps);
    private createCostDashboard;
    private createOperationalDashboard;
    private enableCostExplorer;
}
