#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BillingAlertsStack } from '../lib/billing-alerts-stack';
import { MonitoringStack } from '../lib/monitoring-stack';
import { IamRolesStack } from '../lib/iam-roles-stack';
import { VpcStack } from '../lib/vpc-stack';
import { RdsStack } from '../lib/rds-stack';
import { EcsStack } from '../lib/ecs-stack';
import { S3Stack } from '../lib/s3-stack';
import { LambdaStack } from '../lib/lambda-stack';

const app = new cdk.App();

// Account and region configuration
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'eu-west-2' // London region for UK-based educational platform
};

const commonTags = {
  Project: 'Assisted-CLIMB',
  Environment: 'Production',
  CostCenter: 'Education-Platform',
  Owner: 'Infrastructure-Team'
};

// Stack for billing alerts and cost management
const billingAlertsStack = new BillingAlertsStack(app, 'AssistedClimbBillingAlertsStack', {
  env: {
    ...env,
    region: 'us-east-1' // Billing metrics are only available in us-east-1
  },
  stackName: 'assisted-climb-billing-alerts',
  description: 'Billing alerts and cost monitoring for Assisted CLIMB AWS migration',
  tags: commonTags
});

// Stack for IAM roles and security policies (deploy first)
const iamRolesStack = new IamRolesStack(app, 'AssistedClimbIamRolesStack', {
  env,
  stackName: 'assisted-climb-iam-roles',
  description: 'IAM roles and security policies for Assisted CLIMB AWS services',
  projectName: 'assisted-climb',
  environment: 'production',
  tags: { ...commonTags, Component: 'Security' }
});

// Stack for VPC and network infrastructure
const vpcStack = new VpcStack(app, 'AssistedClimbVpcStack', {
  env,
  stackName: 'assisted-climb-vpc',
  description: 'VPC and network infrastructure for Assisted CLIMB',
  projectName: 'assisted-climb',
  tags: { ...commonTags, Component: 'Network' }
});

// Stack for RDS PostgreSQL database
const rdsStack = new RdsStack(app, 'AssistedClimbRdsStack', {
  env,
  stackName: 'assisted-climb-rds',
  description: 'RDS PostgreSQL database for Assisted CLIMB',
  vpc: vpcStack.vpc,
  rdsSecurityGroup: vpcStack.rdsSecurityGroup,
  monitoringRoleArn: iamRolesStack.rdsMonitoringRole.roleArn,
  projectName: 'assisted-climb',
  tags: { ...commonTags, Component: 'Database' }
});

// Stack for ECS containers and load balancer
const ecsStack = new EcsStack(app, 'AssistedClimbEcsStack', {
  env,
  stackName: 'assisted-climb-ecs',
  description: 'ECS Fargate services and Application Load Balancer for Assisted CLIMB',
  vpc: vpcStack.vpc,
  albSecurityGroup: vpcStack.albSecurityGroup,
  ecsSecurityGroup: vpcStack.ecsSecurityGroup,
  taskExecutionRoleArn: iamRolesStack.ecsTaskExecutionRole.roleArn,
  taskRoleArn: iamRolesStack.ecsTaskRole.roleArn,
  databaseSecretArn: rdsStack.databaseSecret.secretArn,
  projectName: 'assisted-climb',
  domainName: 'assistedclimb.education',
  tags: { ...commonTags, Component: 'Compute' }
});

// Stack for S3 storage and CloudFront CDN
const s3Stack = new S3Stack(app, 'AssistedClimbS3Stack', {
  env,
  stackName: 'assisted-climb-s3-cdn',
  description: 'S3 storage and CloudFront CDN for Assisted CLIMB static assets',
  projectName: 'assisted-climb',
  domainName: 'assistedclimb.education',
  loadBalancerDnsName: ecsStack.loadBalancer.loadBalancerDnsName,
  certificateArn: ecsStack.certificate.certificateArn,
  tags: { ...commonTags, Component: 'Storage-CDN' }
});

// Stack for Lambda AI integration functions
const lambdaStack = new LambdaStack(app, 'AssistedClimbLambdaStack', {
  env,
  stackName: 'assisted-climb-lambda',
  description: 'Lambda functions for AI integration and orchestration',
  vpc: vpcStack.vpc,
  lambdaSecurityGroup: vpcStack.lambdaSecurityGroup,
  lambdaExecutionRoleArn: iamRolesStack.lambdaExecutionRole.roleArn,
  projectName: 'assisted-climb',
  tags: { ...commonTags, Component: 'AI-Integration' }
});

// Stack for application monitoring and operational dashboards
const monitoringStack = new MonitoringStack(app, 'AssistedClimbMonitoringStack', {
  env,
  stackName: 'assisted-climb-monitoring',
  description: 'CloudWatch monitoring and operational dashboards for Assisted CLIMB',
  tags: { ...commonTags, Component: 'Monitoring' }
});

// Set up dependencies
rdsStack.addDependency(vpcStack);
rdsStack.addDependency(iamRolesStack);
ecsStack.addDependency(vpcStack);
ecsStack.addDependency(iamRolesStack);
ecsStack.addDependency(rdsStack);
s3Stack.addDependency(ecsStack);
lambdaStack.addDependency(vpcStack);
lambdaStack.addDependency(iamRolesStack);
monitoringStack.addDependency(ecsStack);