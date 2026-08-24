import * as cdk from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface RdsStackProps extends cdk.StackProps {
  /**
   * VPC for the RDS instance
   */
  vpc: ec2.IVpc;
  
  /**
   * Security group for RDS access
   */
  rdsSecurityGroup: ec2.ISecurityGroup;
  
  /**
   * RDS monitoring role ARN
   */
  monitoringRoleArn: string;
  
  /**
   * Project name for resource naming
   * @default 'assisted-climb'
   */
  projectName?: string;
  
  /**
   * Database instance class
   * @default 'db.t3.micro'
   */
  instanceClass?: ec2.InstanceType;
  
  /**
   * Enable Multi-AZ deployment
   * @default false (single-AZ for cost optimization)
   */
  multiAz?: boolean;
  
  /**
   * Backup retention period in days
   * @default 7
   */
  backupRetentionDays?: number;
}

export class RdsStack extends cdk.Stack {
  public readonly database: rds.DatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;
  public readonly subnetGroup: rds.SubnetGroup;

  constructor(scope: Construct, id: string, props: RdsStackProps) {
    super(scope, id, props);

    const {
      vpc,
      rdsSecurityGroup,
      monitoringRoleArn,
      projectName = 'assisted-climb',
      instanceClass = ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      multiAz = false,
      backupRetentionDays = 7
    } = props;

    // Create database credentials in Secrets Manager
    this.databaseSecret = new secretsmanager.Secret(this, 'DatabaseSecret', {
      secretName: `${projectName}/rds/credentials`,
      description: 'RDS PostgreSQL credentials for Assisted CLIMB',
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'postgres' }),
        generateStringKey: 'password',
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        includeSpace: false,
        passwordLength: 32
      }
    });

    // Create DB subnet group for RDS in isolated subnets
    this.subnetGroup = new rds.SubnetGroup(this, 'DatabaseSubnetGroup', {
      subnetGroupName: `${projectName}-db-subnet-group`,
      description: 'Subnet group for Assisted CLIMB RDS database',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create parameter group for PostgreSQL optimization
    const parameterGroup = new rds.ParameterGroup(this, 'DatabaseParameterGroup', {
      family: rds.ParameterGroupFamily.POSTGRES_15,
      description: 'Custom parameter group for Assisted CLIMB PostgreSQL',
      parameters: {
        // Optimize for educational workload
        shared_preload_libraries: 'pg_stat_statements',
        log_statement: 'all',
        log_min_duration_statement: '1000', // Log queries > 1 second
        max_connections: '100', // Sufficient for pilot deployment
        work_mem: '4MB',
        maintenance_work_mem: '64MB',
        effective_cache_size: '256MB', // Adjust based on instance size
        random_page_cost: '1.1', // Optimize for SSD storage
        // Security settings
        ssl: '1',
        log_connections: '1',
        log_disconnections: '1',
        log_checkpoints: '1'
      }
    });

    // Create RDS PostgreSQL instance
    this.database = new rds.DatabaseInstance(this, 'Database', {
      databaseName: `${projectName.replace(/-/g, '_')}_production`,
      instanceIdentifier: `${projectName}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15_4
      }),
      instanceType: instanceClass,
      credentials: rds.Credentials.fromSecret(this.databaseSecret),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      subnetGroup: this.subnetGroup,
      securityGroups: [rdsSecurityGroup],
      
      // High availability and backup configuration
      multiAz,
      backupRetention: cdk.Duration.days(backupRetentionDays),
      preferredBackupWindow: '03:00-04:00', // Low traffic window
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00', // Sunday early morning
      
      // Storage configuration
      storageType: rds.StorageType.GP2,
      allocatedStorage: 20, // 20GB initial storage
      maxAllocatedStorage: 100, // Auto-scale up to 100GB
      storageEncrypted: true,
      storageEncryptionKey: undefined, // Use AWS managed key for cost optimization
      
      // Performance and monitoring
      parameterGroup,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT, // 7 days free tier
      monitoringInterval: cdk.Duration.minutes(1), // Enhanced monitoring
      monitoringRole: iam.Role.fromRoleArn(this, 'MonitoringRole', monitoringRoleArn),
      
      // Security configuration
      iamAuthentication: false, // Use password authentication for simplicity
      deletionProtection: false, // Set to true for production
      
      // Network and access
      publiclyAccessible: false,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      
      // Cleanup configuration
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT // Take final snapshot on deletion
    });

    // Create read replica for production workloads (commented out for POC)
    /*
    const readReplica = new rds.DatabaseInstanceReadReplica(this, 'DatabaseReadReplica', {
      sourceDatabaseInstance: this.database,
      instanceType: instanceClass,
      vpc,
      securityGroups: [rdsSecurityGroup],
      publiclyAccessible: false,
      deletionProtection: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });
    */

    // Setup automated backups with AWS Backup (for production)
    this.setupAutomatedBackups(projectName);

    // Create CloudWatch alarms for database monitoring
    this.createDatabaseAlarms(projectName);

    // Create outputs
    this.createOutputs();
  }

  private setupAutomatedBackups(projectName: string): void {
    // Create backup vault
    const backupVault = new cdk.aws_backup.BackupVault(this, 'DatabaseBackupVault', {
      backupVaultName: `${projectName}-db-backup-vault`,
      encryptionKey: undefined, // Use AWS managed key
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Create backup plan with multiple recovery points
    const backupPlan = new cdk.aws_backup.BackupPlan(this, 'DatabaseBackupPlan', {
      backupPlanName: `${projectName}-db-backup-plan`,
      backupVault,
      backupPlanRules: [
        // Daily backups for 30 days
        new cdk.aws_backup.BackupPlanRule({
          ruleName: 'DailyBackups',
          scheduleExpression: cdk.aws_events.Schedule.cron({
            hour: '2',
            minute: '0'
          }),
          deleteAfter: cdk.Duration.days(30),
          moveToColdStorageAfter: cdk.Duration.days(7) // Move to cold storage after 7 days
        }),
        // Weekly backups for 90 days
        new cdk.aws_backup.BackupPlanRule({
          ruleName: 'WeeklyBackups',
          scheduleExpression: cdk.aws_events.Schedule.cron({
            weekDay: 'SUN',
            hour: '1',
            minute: '0'
          }),
          deleteAfter: cdk.Duration.days(90),
          moveToColdStorageAfter: cdk.Duration.days(14)
        })
      ]
    });

    // Create backup selection to include RDS instance
    new cdk.aws_backup.BackupSelection(this, 'DatabaseBackupSelection', {
      backupPlan,
      selectionName: `${projectName}-rds-selection`,
      resources: [
        cdk.aws_backup.BackupResource.fromRdsDatabaseInstance(this.database)
      ],
      allowRestores: true
    });
  }

  private createDatabaseAlarms(projectName: string): void {
    // CPU utilization alarm
    new cdk.aws_cloudwatch.Alarm(this, 'DatabaseCpuAlarm', {
      alarmName: `${projectName}-rds-high-cpu`,
      alarmDescription: 'RDS CPU utilization is too high',
      metric: this.database.metricCPUUtilization(),
      threshold: 80,
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Database connections alarm
    new cdk.aws_cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
      alarmName: `${projectName}-rds-high-connections`,
      alarmDescription: 'RDS connection count is approaching limit',
      metric: this.database.metricDatabaseConnections(),
      threshold: 80, // 80% of max connections
      evaluationPeriods: 2,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Free storage space alarm
    new cdk.aws_cloudwatch.Alarm(this, 'DatabaseStorageAlarm', {
      alarmName: `${projectName}-rds-low-storage`,
      alarmDescription: 'RDS free storage space is running low',
      metric: this.database.metricFreeStorageSpace(),
      threshold: 2 * 1024 * 1024 * 1024, // 2GB in bytes
      evaluationPeriods: 1,
      comparisonOperator: cdk.aws_cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    // Read/Write latency alarms
    new cdk.aws_cloudwatch.Alarm(this, 'DatabaseReadLatencyAlarm', {
      alarmName: `${projectName}-rds-high-read-latency`,
      alarmDescription: 'RDS read latency is too high',
      metric: this.database.metricReadLatency(),
      threshold: 0.2, // 200ms
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });

    new cdk.aws_cloudwatch.Alarm(this, 'DatabaseWriteLatencyAlarm', {
      alarmName: `${projectName}-rds-high-write-latency`,
      alarmDescription: 'RDS write latency is too high',
      metric: this.database.metricWriteLatency(),
      threshold: 0.2, // 200ms
      evaluationPeriods: 3,
      treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING
    });
  }

  private createOutputs(): void {
    // Database connection information
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.instanceEndpoint.hostname,
      description: 'RDS PostgreSQL database endpoint',
      exportName: 'AssistedClimbDatabaseEndpoint'
    });

    new cdk.CfnOutput(this, 'DatabasePort', {
      value: this.database.instanceEndpoint.port.toString(),
      description: 'RDS PostgreSQL database port',
      exportName: 'AssistedClimbDatabasePort'
    });

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: this.database.instanceIdentifier,
      description: 'RDS PostgreSQL database name',
      exportName: 'AssistedClimbDatabaseName'
    });

    // Secret information
    new cdk.CfnOutput(this, 'DatabaseSecretArn', {
      value: this.databaseSecret.secretArn,
      description: 'ARN of the database credentials secret',
      exportName: 'AssistedClimbDatabaseSecretArn'
    });

    new cdk.CfnOutput(this, 'DatabaseSecretName', {
      value: this.databaseSecret.secretName,
      description: 'Name of the database credentials secret',
      exportName: 'AssistedClimbDatabaseSecretName'
    });

    // Connection string for application configuration
    new cdk.CfnOutput(this, 'DatabaseConnectionString', {
      value: `postgresql://postgres:{{resolve:secretsmanager:${this.databaseSecret.secretName}:SecretString:password}}@${this.database.instanceEndpoint.hostname}:${this.database.instanceEndpoint.port}/${this.database.instanceIdentifier}`,
      description: 'Database connection string template (password will be resolved at runtime)',
      exportName: 'AssistedClimbDatabaseConnectionString'
    });

    // Monitoring information
    new cdk.CfnOutput(this, 'DatabaseResourceId', {
      value: this.database.instanceResourceId || 'N/A',
      description: 'RDS instance resource ID for monitoring',
      exportName: 'AssistedClimbDatabaseResourceId'
    });
  }
}