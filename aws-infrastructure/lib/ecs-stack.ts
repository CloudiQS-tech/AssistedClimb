import * as cdk from 'aws-cdk-lib';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as certificatemanager from 'aws-cdk-lib/aws-certificatemanager';
import { Construct } from 'constructs';

export interface EcsStackProps extends cdk.StackProps {
  /**
   * VPC for ECS resources
   */
  vpc: ec2.IVpc;
  
  /**
   * Security groups for ALB and ECS
   */
  albSecurityGroup: ec2.ISecurityGroup;
  ecsSecurityGroup: ec2.ISecurityGroup;
  
  /**
   * IAM roles for ECS tasks
   */
  taskExecutionRoleArn: string;
  taskRoleArn: string;
  
  /**
   * Database secret for application configuration
   */
  databaseSecretArn: string;
  
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
  
  /**
   * Domain name for SSL certificate
   * @default 'assistedclimb.education'
   */
  domainName?: string;
  
  /**
   * Environment for container configuration
   * @default 'production'
   */
  environment?: string;
}

export class EcsStack extends cdk.Stack {
  public readonly cluster: ecs.Cluster;
  public readonly frontendService: ecs.FargateService;
  public readonly backendService: ecs.FargateService;
  public readonly loadBalancer: elbv2.ApplicationLoadBalancer;
  public readonly frontendRepository: ecr.Repository;
  public readonly backendRepository: ecr.Repository;
  public readonly certificate: certificatemanager.Certificate;

  constructor(scope: Construct, id: string, props: EcsStackProps) {
    super(scope, id, props);

    const {
      vpc,
      albSecurityGroup,
      ecsSecurityGroup,
      taskExecutionRoleArn,
      taskRoleArn,
      databaseSecretArn,
      projectName = 'assisted-climb',
      domainName = 'assistedclimb.education',
      environment = 'production'
    } = props;

    // Create ECR repositories for container images
    this.frontendRepository = this.createEcrRepository(`${projectName}-frontend`);
    this.backendRepository = this.createEcrRepository(`${projectName}-backend`);

    // Create ECS Cluster
    this.cluster = new ecs.Cluster(this, 'EcsCluster', {
      clusterName: `${projectName}-cluster`,
      vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true
    });

    // Create Application Load Balancer
    this.loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'ApplicationLoadBalancer', {
      loadBalancerName: `${projectName}-alb`,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: albSecurityGroup,
      internetFacing: true,
      deletionProtection: false // Set to true for production
    });

    // Create SSL certificate
    this.certificate = new certificatemanager.Certificate(this, 'SslCertificate', {
      domainName: `*.${domainName}`,
      subjectAlternativeNames: [domainName],
      validation: certificatemanager.CertificateValidation.fromDns()
    });

    // Create task definitions and services
    const { frontendTaskDefinition, backendTaskDefinition } = this.createTaskDefinitions(
      projectName,
      environment,
      taskExecutionRoleArn,
      taskRoleArn,
      databaseSecretArn
    );

    // Create ECS services
    this.frontendService = this.createFrontendService(frontendTaskDefinition, ecsSecurityGroup);
    this.backendService = this.createBackendService(backendTaskDefinition, ecsSecurityGroup);

    // Configure load balancer routing
    this.configureLoadBalancerRouting();

    // Create CloudWatch alarms for monitoring
    this.createServiceAlarms(projectName);

    // Create outputs
    this.createOutputs();
  }

  private createEcrRepository(repositoryName: string): ecr.Repository {
    return new ecr.Repository(this, `${repositoryName.charAt(0).toUpperCase() + repositoryName.slice(1)}Repository`, {
      repositoryName,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecyclePolicy: ecr.LifecyclePolicy.fromLifecyclePolicyText(JSON.stringify({
        rules: [
          {
            rulePriority: 1,
            description: 'Keep last 10 production images',
            selection: {
              tagStatus: 'tagged',
              tagPrefixList: ['production', 'latest'],
              countType: 'imageCountMoreThan',
              countNumber: 10
            },
            action: {
              type: 'expire'
            }
          },
          {
            rulePriority: 2,
            description: 'Keep only 5 untagged images',
            selection: {
              tagStatus: 'untagged',
              countType: 'imageCountMoreThan',
              countNumber: 5
            },
            action: {
              type: 'expire'
            }
          }
        ]
      })),
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
  }

  private createTaskDefinitions(
    projectName: string,
    environment: string,
    taskExecutionRoleArn: string,
    taskRoleArn: string,
    databaseSecretArn: string
  ): { frontendTaskDefinition: ecs.FargateTaskDefinition; backendTaskDefinition: ecs.FargateTaskDefinition } {
    
    // Import IAM roles
    const taskExecutionRole = iam.Role.fromRoleArn(this, 'ImportedTaskExecutionRole', taskExecutionRoleArn);
    const taskRole = iam.Role.fromRoleArn(this, 'ImportedTaskRole', taskRoleArn);

    // Create log groups
    const frontendLogGroup = new logs.LogGroup(this, 'FrontendLogGroup', {
      logGroupName: `/aws/ecs/${projectName}/frontend`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const backendLogGroup = new logs.LogGroup(this, 'BackendLogGroup', {
      logGroupName: `/aws/ecs/${projectName}/backend`,
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Frontend task definition
    const frontendTaskDefinition = new ecs.FargateTaskDefinition(this, 'FrontendTaskDefinition', {
      family: `${projectName}-frontend`,
      cpu: 512,
      memoryLimitMiB: 1024,
      executionRole: taskExecutionRole,
      taskRole: taskRole
    });

    frontendTaskDefinition.addContainer('frontend', {
      containerName: 'frontend',
      image: ecs.ContainerImage.fromEcrRepository(this.frontendRepository, 'latest'),
      portMappings: [{ 
        containerPort: 3000,
        protocol: ecs.Protocol.TCP
      }],
      environment: {
        NODE_ENV: environment,
        REACT_APP_API_URL: `/api`, // Use relative URL for same-origin requests
        REACT_APP_ENVIRONMENT: environment
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: frontendLogGroup,
        streamPrefix: 'frontend'
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60)
      }
    });

    // Backend task definition
    const backendTaskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTaskDefinition', {
      family: `${projectName}-backend`,
      cpu: 1024,
      memoryLimitMiB: 2048,
      executionRole: taskExecutionRole,
      taskRole: taskRole
    });

    // Import database secret
    const databaseSecret = secretsmanager.Secret.fromSecretCompleteArn(this, 'ImportedDatabaseSecret', databaseSecretArn);

    backendTaskDefinition.addContainer('backend', {
      containerName: 'backend',
      image: ecs.ContainerImage.fromEcrRepository(this.backendRepository, 'latest'),
      portMappings: [{
        containerPort: 8080,
        protocol: ecs.Protocol.TCP
      }],
      environment: {
        NODE_ENV: environment,
        PORT: '8080',
        CORS_ORIGINS: `https://app.${domainName},https://${domainName}`,
        LOG_LEVEL: 'info',
        SESSION_TIMEOUT: '28800000', // 8 hours
        BCRYPT_ROUNDS: '12'
      },
      secrets: {
        // Database configuration from Secrets Manager
        DATABASE_URL: ecs.Secret.fromSecretsManager(databaseSecret, 'connectionString'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password'),
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
        DATABASE_HOST: ecs.Secret.fromSecretsManager(databaseSecret, 'host'),
        DATABASE_PORT: ecs.Secret.fromSecretsManager(databaseSecret, 'port'),
        DATABASE_NAME: ecs.Secret.fromSecretsManager(databaseSecret, 'dbname'),
        
        // Session secret (to be created separately)
        SESSION_SECRET: ecs.Secret.fromSecretsManagerAttributes(this, 'SessionSecret', {
          secretCompleteArn: `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${projectName}/session-secret`
        })
      },
      logging: ecs.LogDrivers.awsLogs({
        logGroup: backendLogGroup,
        streamPrefix: 'backend'
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:8080/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60)
      }
    });

    return { frontendTaskDefinition, backendTaskDefinition };
  }

  private createFrontendService(
    taskDefinition: ecs.FargateTaskDefinition,
    securityGroup: ec2.ISecurityGroup
  ): ecs.FargateService {
    return new ecs.FargateService(this, 'FrontendService', {
      serviceName: `${this.node.tryGetContext('projectName') || 'assisted-climb'}-frontend`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 2, // Run 2 instances for high availability
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      capacityProviderStrategies: [{
        capacityProvider: 'FARGATE',
        weight: 1
      }],
      enableExecuteCommand: false, // Set to true for debugging
      deploymentConfiguration: {
        maximumPercent: 200,
        minimumHealthyPercent: 50,
        deploymentCircuitBreaker: {
          rollback: true
        }
      }
    });
  }

  private createBackendService(
    taskDefinition: ecs.FargateTaskDefinition,
    securityGroup: ec2.ISecurityGroup
  ): ecs.FargateService {
    return new ecs.FargateService(this, 'BackendService', {
      serviceName: `${this.node.tryGetContext('projectName') || 'assisted-climb'}-backend`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount: 2, // Run 2 instances for high availability
      securityGroups: [securityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      capacityProviderStrategies: [{
        capacityProvider: 'FARGATE',
        weight: 1
      }],
      enableExecuteCommand: false, // Set to true for debugging
      deploymentConfiguration: {
        maximumPercent: 200,
        minimumHealthyPercent: 50,
        deploymentCircuitBreaker: {
          rollback: true
        }
      }
    });
  }

  private configureLoadBalancerRouting(): void {
    // Frontend target group
    const frontendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'FrontendTargetGroup', {
      targetGroupName: `${this.node.tryGetContext('projectName') || 'assisted-climb'}-frontend-tg`,
      vpc: this.cluster.vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5
      },
      deregistrationDelay: cdk.Duration.seconds(30)
    });

    // Backend target group
    const backendTargetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTargetGroup', {
      targetGroupName: `${this.node.tryGetContext('projectName') || 'assisted-climb'}-backend-tg`,
      vpc: this.cluster.vpc,
      port: 8080,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        enabled: true,
        healthyHttpCodes: '200',
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 5
      },
      deregistrationDelay: cdk.Duration.seconds(30)
    });

    // Register services with target groups
    frontendTargetGroup.addTarget(this.frontendService);
    backendTargetGroup.addTarget(this.backendService);

    // HTTP listener (redirect to HTTPS)
    this.loadBalancer.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.redirect({
        protocol: 'HTTPS',
        port: '443',
        permanent: true
      })
    });

    // HTTPS listener with routing rules
    const httpsListener = this.loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elbv2.ApplicationProtocol.HTTPS,
      certificates: [this.certificate],
      defaultAction: elbv2.ListenerAction.forward([frontendTargetGroup])
    });

    // API routing - forward /api/* to backend
    httpsListener.addAction('ApiRouting', {
      priority: 100,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/api/*'])
      ],
      action: elbv2.ListenerAction.forward([backendTargetGroup])
    });

    // Health check routing for backend
    httpsListener.addAction('BackendHealthCheck', {
      priority: 200,
      conditions: [
        elbv2.ListenerCondition.pathPatterns(['/health'])
      ],
      action: elbv2.ListenerAction.forward([backendTargetGroup])
    });
  }

  private createServiceAlarms(projectName: string): void {
    // Frontend service alarms
    new cdk.aws_cloudwatch.Alarm(this, 'FrontendServiceCpuAlarm', {
      alarmName: `${projectName}-frontend-high-cpu`,
      alarmDescription: 'Frontend service CPU utilization is high',
      metric: this.frontendService.metricCpuUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new cdk.aws_cloudwatch.Alarm(this, 'FrontendServiceMemoryAlarm', {
      alarmName: `${projectName}-frontend-high-memory`,
      alarmDescription: 'Frontend service memory utilization is high',
      metric: this.frontendService.metricMemoryUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Backend service alarms
    new cdk.aws_cloudwatch.Alarm(this, 'BackendServiceCpuAlarm', {
      alarmName: `${projectName}-backend-high-cpu`,
      alarmDescription: 'Backend service CPU utilization is high',
      metric: this.backendService.metricCpuUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new cdk.aws_cloudwatch.Alarm(this, 'BackendServiceMemoryAlarm', {
      alarmName: `${projectName}-backend-high-memory`,
      alarmDescription: 'Backend service memory utilization is high',
      metric: this.backendService.metricMemoryUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Load balancer alarms
    new cdk.aws_cloudwatch.Alarm(this, 'LoadBalancerResponseTimeAlarm', {
      alarmName: `${projectName}-alb-high-response-time`,
      alarmDescription: 'Load balancer response time is high',
      metric: new cdk.aws_cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'TargetResponseTime',
        dimensionsMap: {
          LoadBalancer: this.loadBalancer.loadBalancerFullName
        },
        statistic: 'Average'
      }),
      threshold: 2, // 2 seconds
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new cdk.aws_cloudwatch.Alarm(this, 'LoadBalancer5xxErrorsAlarm', {
      alarmName: `${projectName}-alb-5xx-errors`,
      alarmDescription: 'Load balancer is returning 5xx errors',
      metric: new cdk.aws_cloudwatch.Metric({
        namespace: 'AWS/ApplicationELB',
        metricName: 'HTTPCode_Target_5XX_Count',
        dimensionsMap: {
          LoadBalancer: this.loadBalancer.loadBalancerFullName
        },
        statistic: 'Sum',
        period: cdk.Duration.minutes(5)
      }),
      threshold: 10,
      evaluationPeriods: 2,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });
  }

  private createOutputs(): void {
    // Load balancer outputs
    new cdk.CfnOutput(this, 'LoadBalancerDnsName', {
      value: this.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the Application Load Balancer',
      exportName: 'AssistedClimbLoadBalancerDnsName'
    });

    new cdk.CfnOutput(this, 'LoadBalancerArn', {
      value: this.loadBalancer.loadBalancerArn,
      description: 'ARN of the Application Load Balancer',
      exportName: 'AssistedClimbLoadBalancerArn'
    });

    new cdk.CfnOutput(this, 'LoadBalancerCanonicalHostedZoneId', {
      value: this.loadBalancer.loadBalancerCanonicalHostedZoneId,
      description: 'Canonical hosted zone ID of the load balancer',
      exportName: 'AssistedClimbLoadBalancerHostedZoneId'
    });

    // ECS cluster outputs
    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.cluster.clusterName,
      description: 'Name of the ECS cluster',
      exportName: 'AssistedClimbEcsClusterName'
    });

    new cdk.CfnOutput(this, 'EcsClusterArn', {
      value: this.cluster.clusterArn,
      description: 'ARN of the ECS cluster',
      exportName: 'AssistedClimbEcsClusterArn'
    });

    // ECR repository outputs
    new cdk.CfnOutput(this, 'FrontendRepositoryUri', {
      value: this.frontendRepository.repositoryUri,
      description: 'URI of the frontend ECR repository',
      exportName: 'AssistedClimbFrontendRepositoryUri'
    });

    new cdk.CfnOutput(this, 'BackendRepositoryUri', {
      value: this.backendRepository.repositoryUri,
      description: 'URI of the backend ECR repository',
      exportName: 'AssistedClimbBackendRepositoryUri'
    });

    // SSL certificate output
    new cdk.CfnOutput(this, 'SslCertificateArn', {
      value: this.certificate.certificateArn,
      description: 'ARN of the SSL certificate',
      exportName: 'AssistedClimbSslCertificateArn'
    });

    // Service outputs
    new cdk.CfnOutput(this, 'FrontendServiceName', {
      value: this.frontendService.serviceName,
      description: 'Name of the frontend ECS service',
      exportName: 'AssistedClimbFrontendServiceName'
    });

    new cdk.CfnOutput(this, 'BackendServiceName', {
      value: this.backendService.serviceName,
      description: 'Name of the backend ECS service',
      exportName: 'AssistedClimbBackendServiceName'
    });

    // Application URL
    new cdk.CfnOutput(this, 'ApplicationUrl', {
      value: `https://${this.loadBalancer.loadBalancerDnsName}`,
      description: 'URL to access the Assisted CLIMB application',
      exportName: 'AssistedClimbApplicationUrl'
    });
  }
}