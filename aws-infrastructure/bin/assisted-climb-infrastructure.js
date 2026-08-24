#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("aws-cdk-lib");
const billing_alerts_stack_1 = require("../lib/billing-alerts-stack");
const monitoring_stack_1 = require("../lib/monitoring-stack");
const iam_roles_stack_1 = require("../lib/iam-roles-stack");
const app = new cdk.App();
// Account and region configuration
const env = {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: 'eu-west-2' // London region for UK-based educational platform
};
// Stack for billing alerts and cost management
new billing_alerts_stack_1.BillingAlertsStack(app, 'AssistedClimbBillingAlertsStack', {
    env: {
        ...env,
        region: 'us-east-1' // Billing metrics are only available in us-east-1
    },
    stackName: 'assisted-climb-billing-alerts',
    description: 'Billing alerts and cost monitoring for Assisted CLIMB AWS migration',
    tags: {
        Project: 'Assisted-CLIMB',
        Environment: 'Production',
        CostCenter: 'Education-Platform',
        Owner: 'Infrastructure-Team'
    }
});
// Stack for application monitoring and operational dashboards
new monitoring_stack_1.MonitoringStack(app, 'AssistedClimbMonitoringStack', {
    env,
    stackName: 'assisted-climb-monitoring',
    description: 'CloudWatch monitoring and operational dashboards for Assisted CLIMB',
    tags: {
        Project: 'Assisted-CLIMB',
        Environment: 'Production',
        CostCenter: 'Education-Platform',
        Owner: 'Infrastructure-Team'
    }
});
// Stack for IAM roles and security policies
new iam_roles_stack_1.IamRolesStack(app, 'AssistedClimbIamRolesStack', {
    env,
    stackName: 'assisted-climb-iam-roles',
    description: 'IAM roles and security policies for Assisted CLIMB AWS services',
    projectName: 'assisted-climb',
    environment: 'production',
    tags: {
        Project: 'Assisted-CLIMB',
        Environment: 'Production',
        CostCenter: 'Education-Platform',
        Owner: 'Infrastructure-Team',
        Component: 'Security'
    }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYXNzaXN0ZWQtY2xpbWItaW5mcmFzdHJ1Y3R1cmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJhc3Npc3RlZC1jbGltYi1pbmZyYXN0cnVjdHVyZS50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMsbUNBQW1DO0FBQ25DLHNFQUFpRTtBQUNqRSw4REFBMEQ7QUFDMUQsNERBQXVEO0FBRXZELE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBRTFCLG1DQUFtQztBQUNuQyxNQUFNLEdBQUcsR0FBRztJQUNWLE9BQU8sRUFBRSxPQUFPLENBQUMsR0FBRyxDQUFDLG1CQUFtQjtJQUN4QyxNQUFNLEVBQUUsV0FBVyxDQUFDLGtEQUFrRDtDQUN2RSxDQUFDO0FBRUYsK0NBQStDO0FBQy9DLElBQUkseUNBQWtCLENBQUMsR0FBRyxFQUFFLGlDQUFpQyxFQUFFO0lBQzdELEdBQUcsRUFBRTtRQUNILEdBQUcsR0FBRztRQUNOLE1BQU0sRUFBRSxXQUFXLENBQUMsa0RBQWtEO0tBQ3ZFO0lBQ0QsU0FBUyxFQUFFLCtCQUErQjtJQUMxQyxXQUFXLEVBQUUscUVBQXFFO0lBQ2xGLElBQUksRUFBRTtRQUNKLE9BQU8sRUFBRSxnQkFBZ0I7UUFDekIsV0FBVyxFQUFFLFlBQVk7UUFDekIsVUFBVSxFQUFFLG9CQUFvQjtRQUNoQyxLQUFLLEVBQUUscUJBQXFCO0tBQzdCO0NBQ0YsQ0FBQyxDQUFDO0FBRUgsOERBQThEO0FBQzlELElBQUksa0NBQWUsQ0FBQyxHQUFHLEVBQUUsOEJBQThCLEVBQUU7SUFDdkQsR0FBRztJQUNILFNBQVMsRUFBRSwyQkFBMkI7SUFDdEMsV0FBVyxFQUFFLHFFQUFxRTtJQUNsRixJQUFJLEVBQUU7UUFDSixPQUFPLEVBQUUsZ0JBQWdCO1FBQ3pCLFdBQVcsRUFBRSxZQUFZO1FBQ3pCLFVBQVUsRUFBRSxvQkFBb0I7UUFDaEMsS0FBSyxFQUFFLHFCQUFxQjtLQUM3QjtDQUNGLENBQUMsQ0FBQztBQUVILDRDQUE0QztBQUM1QyxJQUFJLCtCQUFhLENBQUMsR0FBRyxFQUFFLDRCQUE0QixFQUFFO0lBQ25ELEdBQUc7SUFDSCxTQUFTLEVBQUUsMEJBQTBCO0lBQ3JDLFdBQVcsRUFBRSxpRUFBaUU7SUFDOUUsV0FBVyxFQUFFLGdCQUFnQjtJQUM3QixXQUFXLEVBQUUsWUFBWTtJQUN6QixJQUFJLEVBQUU7UUFDSixPQUFPLEVBQUUsZ0JBQWdCO1FBQ3pCLFdBQVcsRUFBRSxZQUFZO1FBQ3pCLFVBQVUsRUFBRSxvQkFBb0I7UUFDaEMsS0FBSyxFQUFFLHFCQUFxQjtRQUM1QixTQUFTLEVBQUUsVUFBVTtLQUN0QjtDQUNGLENBQUMsQ0FBQyIsInNvdXJjZXNDb250ZW50IjpbIiMhL3Vzci9iaW4vZW52IG5vZGVcbmltcG9ydCAnc291cmNlLW1hcC1zdXBwb3J0L3JlZ2lzdGVyJztcbmltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgeyBCaWxsaW5nQWxlcnRzU3RhY2sgfSBmcm9tICcuLi9saWIvYmlsbGluZy1hbGVydHMtc3RhY2snO1xuaW1wb3J0IHsgTW9uaXRvcmluZ1N0YWNrIH0gZnJvbSAnLi4vbGliL21vbml0b3Jpbmctc3RhY2snO1xuaW1wb3J0IHsgSWFtUm9sZXNTdGFjayB9IGZyb20gJy4uL2xpYi9pYW0tcm9sZXMtc3RhY2snO1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xuXG4vLyBBY2NvdW50IGFuZCByZWdpb24gY29uZmlndXJhdGlvblxuY29uc3QgZW52ID0ge1xuICBhY2NvdW50OiBwcm9jZXNzLmVudi5DREtfREVGQVVMVF9BQ0NPVU5ULFxuICByZWdpb246ICdldS13ZXN0LTInIC8vIExvbmRvbiByZWdpb24gZm9yIFVLLWJhc2VkIGVkdWNhdGlvbmFsIHBsYXRmb3JtXG59O1xuXG4vLyBTdGFjayBmb3IgYmlsbGluZyBhbGVydHMgYW5kIGNvc3QgbWFuYWdlbWVudFxubmV3IEJpbGxpbmdBbGVydHNTdGFjayhhcHAsICdBc3Npc3RlZENsaW1iQmlsbGluZ0FsZXJ0c1N0YWNrJywge1xuICBlbnY6IHtcbiAgICAuLi5lbnYsXG4gICAgcmVnaW9uOiAndXMtZWFzdC0xJyAvLyBCaWxsaW5nIG1ldHJpY3MgYXJlIG9ubHkgYXZhaWxhYmxlIGluIHVzLWVhc3QtMVxuICB9LFxuICBzdGFja05hbWU6ICdhc3Npc3RlZC1jbGltYi1iaWxsaW5nLWFsZXJ0cycsXG4gIGRlc2NyaXB0aW9uOiAnQmlsbGluZyBhbGVydHMgYW5kIGNvc3QgbW9uaXRvcmluZyBmb3IgQXNzaXN0ZWQgQ0xJTUIgQVdTIG1pZ3JhdGlvbicsXG4gIHRhZ3M6IHtcbiAgICBQcm9qZWN0OiAnQXNzaXN0ZWQtQ0xJTUInLFxuICAgIEVudmlyb25tZW50OiAnUHJvZHVjdGlvbicsXG4gICAgQ29zdENlbnRlcjogJ0VkdWNhdGlvbi1QbGF0Zm9ybScsXG4gICAgT3duZXI6ICdJbmZyYXN0cnVjdHVyZS1UZWFtJ1xuICB9XG59KTtcblxuLy8gU3RhY2sgZm9yIGFwcGxpY2F0aW9uIG1vbml0b3JpbmcgYW5kIG9wZXJhdGlvbmFsIGRhc2hib2FyZHNcbm5ldyBNb25pdG9yaW5nU3RhY2soYXBwLCAnQXNzaXN0ZWRDbGltYk1vbml0b3JpbmdTdGFjaycsIHtcbiAgZW52LFxuICBzdGFja05hbWU6ICdhc3Npc3RlZC1jbGltYi1tb25pdG9yaW5nJyxcbiAgZGVzY3JpcHRpb246ICdDbG91ZFdhdGNoIG1vbml0b3JpbmcgYW5kIG9wZXJhdGlvbmFsIGRhc2hib2FyZHMgZm9yIEFzc2lzdGVkIENMSU1CJyxcbiAgdGFnczoge1xuICAgIFByb2plY3Q6ICdBc3Npc3RlZC1DTElNQicsXG4gICAgRW52aXJvbm1lbnQ6ICdQcm9kdWN0aW9uJyxcbiAgICBDb3N0Q2VudGVyOiAnRWR1Y2F0aW9uLVBsYXRmb3JtJyxcbiAgICBPd25lcjogJ0luZnJhc3RydWN0dXJlLVRlYW0nXG4gIH1cbn0pO1xuXG4vLyBTdGFjayBmb3IgSUFNIHJvbGVzIGFuZCBzZWN1cml0eSBwb2xpY2llc1xubmV3IElhbVJvbGVzU3RhY2soYXBwLCAnQXNzaXN0ZWRDbGltYklhbVJvbGVzU3RhY2snLCB7XG4gIGVudixcbiAgc3RhY2tOYW1lOiAnYXNzaXN0ZWQtY2xpbWItaWFtLXJvbGVzJyxcbiAgZGVzY3JpcHRpb246ICdJQU0gcm9sZXMgYW5kIHNlY3VyaXR5IHBvbGljaWVzIGZvciBBc3Npc3RlZCBDTElNQiBBV1Mgc2VydmljZXMnLFxuICBwcm9qZWN0TmFtZTogJ2Fzc2lzdGVkLWNsaW1iJyxcbiAgZW52aXJvbm1lbnQ6ICdwcm9kdWN0aW9uJyxcbiAgdGFnczoge1xuICAgIFByb2plY3Q6ICdBc3Npc3RlZC1DTElNQicsXG4gICAgRW52aXJvbm1lbnQ6ICdQcm9kdWN0aW9uJyxcbiAgICBDb3N0Q2VudGVyOiAnRWR1Y2F0aW9uLVBsYXRmb3JtJyxcbiAgICBPd25lcjogJ0luZnJhc3RydWN0dXJlLVRlYW0nLFxuICAgIENvbXBvbmVudDogJ1NlY3VyaXR5J1xuICB9XG59KTsiXX0=