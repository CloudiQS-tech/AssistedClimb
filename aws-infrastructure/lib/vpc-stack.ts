import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export interface VpcStackProps extends cdk.StackProps {
  /**
   * CIDR block for the VPC
   * @default '10.0.0.0/16'
   */
  cidrBlock?: string;
  
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
  
  /**
   * Enable VPC Flow Logs for security monitoring
   * @default true
   */
  enableFlowLogs?: boolean;
}

export class VpcStack extends cdk.Stack {
  public readonly vpc: ec2.Vpc;
  public readonly publicSubnets: ec2.ISubnet[];
  public readonly privateSubnets: ec2.ISubnet[];
  public readonly databaseSubnets: ec2.ISubnet[];
  public readonly albSecurityGroup: ec2.SecurityGroup;
  public readonly ecsSecurityGroup: ec2.SecurityGroup;
  public readonly rdsSecurityGroup: ec2.SecurityGroup;
  public readonly lambdaSecurityGroup: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: VpcStackProps = {}) {
    super(scope, id, props);

    const {
      cidrBlock = '10.0.0.0/16',
      projectName = 'assisted-climb',
      enableFlowLogs = true
    } = props;

    // Create VPC with public, private, and isolated subnets
    this.vpc = new ec2.Vpc(this, 'AssistedClimbVpc', {
      vpcName: `${projectName}-vpc`,
      cidr: cidrBlock,
      maxAzs: 2, // Use 2 AZs for high availability
      enableDnsHostnames: true,
      enableDnsSupport: true,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
      // Use VPC endpoints instead of NAT Gateways for cost optimization
      natGateways: 0 // Will use VPC endpoints instead
    });

    // Store subnet references
    this.publicSubnets = this.vpc.publicSubnets;
    this.privateSubnets = this.vpc.privateSubnets;
    this.databaseSubnets = this.vpc.isolatedSubnets;

    // Create VPC Endpoints for cost optimization (avoid NAT Gateway costs)
    this.createVpcEndpoints(projectName);

    // Create Security Groups
    this.albSecurityGroup = this.createAlbSecurityGroup(projectName);
    this.ecsSecurityGroup = this.createEcsSecurityGroup(projectName);
    this.rdsSecurityGroup = this.createRdsSecurityGroup(projectName);
    this.lambdaSecurityGroup = this.createLambdaSecurityGroup(projectName);

    // Enable VPC Flow Logs for security monitoring
    if (enableFlowLogs) {
      this.enableVpcFlowLogs(projectName);
    }

    // Create outputs
    this.createOutputs();
  }

  private createVpcEndpoints(projectName: string): void {
    // S3 Gateway Endpoint (free)
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }]
    });

    // DynamoDB Gateway Endpoint (free) - for future AI audit logging
    this.vpc.addGatewayEndpoint('DynamoDbEndpoint', {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
      subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }]
    });

    // Secrets Manager VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true
    });

    // CloudWatch Logs VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true
    });

    // ECR API VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true
    });

    // ECR DKR VPC Endpoint
    new ec2.InterfaceVpcEndpoint(this, 'EcrDkrEndpoint', {
      vpc: this.vpc,
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true
    });
  }

  private createAlbSecurityGroup(projectName: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      securityGroupName: `${projectName}-alb-sg`,
      vpc: this.vpc,
      description: 'Security group for Application Load Balancer - allows HTTP and HTTPS traffic',
      allowAllOutbound: true
    });

    // Allow HTTP traffic from internet (will redirect to HTTPS)
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Allow HTTP traffic from internet'
    );

    // Allow HTTPS traffic from internet
    sg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'Allow HTTPS traffic from internet'
    );

    // Tag the security group
    cdk.Tags.of(sg).add('Name', `${projectName}-alb-security-group`);
    cdk.Tags.of(sg).add('Component', 'LoadBalancer');

    return sg;
  }

  private createEcsSecurityGroup(projectName: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, 'EcsSecurityGroup', {
      securityGroupName: `${projectName}-ecs-sg`,
      vpc: this.vpc,
      description: 'Security group for ECS containers - allows traffic from ALB and outbound HTTPS',
      allowAllOutbound: true // Needed for downloading container images and external API calls
    });

    // Allow traffic from ALB security group on port 3000 (frontend) and 8080 (backend)
    sg.addIngressRule(
      ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      ec2.Port.tcp(3000),
      'Allow traffic from ALB to frontend container'
    );

    sg.addIngressRule(
      ec2.Peer.securityGroupId(this.albSecurityGroup.securityGroupId),
      ec2.Port.tcp(8080),
      'Allow traffic from ALB to backend container'
    );

    // Allow internal container-to-container communication
    sg.addIngressRule(
      sg,
      ec2.Port.allTcp(),
      'Allow internal ECS service communication'
    );

    cdk.Tags.of(sg).add('Name', `${projectName}-ecs-security-group`);
    cdk.Tags.of(sg).add('Component', 'Compute');

    return sg;
  }

  private createRdsSecurityGroup(projectName: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, 'RdsSecurityGroup', {
      securityGroupName: `${projectName}-rds-sg`,
      vpc: this.vpc,
      description: 'Security group for RDS PostgreSQL - allows access only from ECS containers',
      allowAllOutbound: false // Database should not initiate outbound connections
    });

    // Allow PostgreSQL access from ECS security group only
    sg.addIngressRule(
      ec2.Peer.securityGroupId(this.ecsSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from ECS containers'
    );

    // Allow access from Lambda functions for AI operations
    sg.addIngressRule(
      ec2.Peer.securityGroupId(this.lambdaSecurityGroup.securityGroupId),
      ec2.Port.tcp(5432),
      'Allow PostgreSQL access from Lambda functions'
    );

    cdk.Tags.of(sg).add('Name', `${projectName}-rds-security-group`);
    cdk.Tags.of(sg).add('Component', 'Database');

    return sg;
  }

  private createLambdaSecurityGroup(projectName: string): ec2.SecurityGroup {
    const sg = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      securityGroupName: `${projectName}-lambda-sg`,
      vpc: this.vpc,
      description: 'Security group for Lambda functions - allows outbound HTTPS for AI API calls',
      allowAllOutbound: true // Needed for AI API calls to external providers
    });

    cdk.Tags.of(sg).add('Name', `${projectName}-lambda-security-group`);
    cdk.Tags.of(sg).add('Component', 'Serverless');

    return sg;
  }

  private enableVpcFlowLogs(projectName: string): void {
    // Create CloudWatch Log Group for VPC Flow Logs
    const flowLogGroup = new cdk.aws_logs.LogGroup(this, 'VpcFlowLogGroup', {
      logGroupName: `/aws/vpc/flowlogs/${projectName}`,
      retention: cdk.aws_logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create IAM role for VPC Flow Logs
    const flowLogRole = new cdk.aws_iam.Role(this, 'VpcFlowLogRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
      inlinePolicies: {
        FlowLogDeliveryRolePolicy: new cdk.aws_iam.PolicyDocument({
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              actions: [
                'logs:CreateLogGroup',
                'logs:CreateLogStream',
                'logs:PutLogEvents',
                'logs:DescribeLogGroups',
                'logs:DescribeLogStreams'
              ],
              resources: ['*']
            })
          ]
        })
      }
    });

    // Enable VPC Flow Logs
    new ec2.CfnFlowLog(this, 'VpcFlowLog', {
      resourceType: 'VPC',
      resourceId: this.vpc.vpcId,
      trafficType: 'ALL',
      logDestinationType: 'cloud-watch-logs',
      logGroupName: flowLogGroup.logGroupName,
      deliverLogsPermissionArn: flowLogRole.roleArn,
      logFormat: '${account-id} ${interface-id} ${srcaddr} ${dstaddr} ${srcport} ${dstport} ${protocol} ${packets} ${bytes} ${windowstart} ${windowend} ${action} ${flowlogstatus}',
      tags: [
        { key: 'Name', value: `${projectName}-vpc-flow-logs` },
        { key: 'Component', value: 'Security' }
      ]
    });
  }

  private createOutputs(): void {
    // VPC outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: 'VPC ID for the Assisted CLIMB infrastructure',
      exportName: 'AssistedClimbVpcId'
    });

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: 'CIDR block of the VPC',
      exportName: 'AssistedClimbVpcCidr'
    });

    // Subnet outputs
    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: this.publicSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Comma-separated list of public subnet IDs',
      exportName: 'AssistedClimbPublicSubnetIds'
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: this.privateSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Comma-separated list of private subnet IDs',
      exportName: 'AssistedClimbPrivateSubnetIds'
    });

    new cdk.CfnOutput(this, 'DatabaseSubnetIds', {
      value: this.databaseSubnets.map(subnet => subnet.subnetId).join(','),
      description: 'Comma-separated list of database subnet IDs',
      exportName: 'AssistedClimbDatabaseSubnetIds'
    });

    // Security Group outputs
    new cdk.CfnOutput(this, 'AlbSecurityGroupId', {
      value: this.albSecurityGroup.securityGroupId,
      description: 'Security Group ID for Application Load Balancer',
      exportName: 'AssistedClimbAlbSecurityGroupId'
    });

    new cdk.CfnOutput(this, 'EcsSecurityGroupId', {
      value: this.ecsSecurityGroup.securityGroupId,
      description: 'Security Group ID for ECS containers',
      exportName: 'AssistedClimbEcsSecurityGroupId'
    });

    new cdk.CfnOutput(this, 'RdsSecurityGroupId', {
      value: this.rdsSecurityGroup.securityGroupId,
      description: 'Security Group ID for RDS database',
      exportName: 'AssistedClimbRdsSecurityGroupId'
    });

    new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      description: 'Security Group ID for Lambda functions',
      exportName: 'AssistedClimbLambdaSecurityGroupId'
    });

    // Availability Zones output
    new cdk.CfnOutput(this, 'AvailabilityZones', {
      value: this.vpc.availabilityZones.join(','),
      description: 'Comma-separated list of availability zones',
      exportName: 'AssistedClimbAvailabilityZones'
    });
  }
}