import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
export interface IamRolesStackProps extends cdk.StackProps {
    /**
     * Environment name for resource tagging
     * @default 'development'
     */
    environment?: string;
    /**
     * Project name for resource naming
     * @default 'assisted-climb'
     */
    projectName?: string;
}
export declare class IamRolesStack extends cdk.Stack {
    readonly ecsTaskExecutionRole: iam.Role;
    readonly ecsTaskRole: iam.Role;
    readonly lambdaExecutionRole: iam.Role;
    readonly rdsMonitoringRole: iam.Role;
    readonly rdsBackupRole: iam.Role;
    constructor(scope: Construct, id: string, props?: IamRolesStackProps);
    private createEcsTaskExecutionRole;
    private createEcsTaskRole;
    private createLambdaExecutionRole;
    private createRdsMonitoringRole;
    private createRdsBackupRole;
    private addCommonTags;
    private createOutputs;
}
