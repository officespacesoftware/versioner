#!/usr/bin/env node

// Test the complete minor RC workflow in dry-run mode
import { GitFlowManager } from './lib/git-flow.js';
import { ReleaseAgent } from './lib/release-agent.js';

async function testWorkflow() {
  console.log('🚀 Testing Minor RC Workflow (Dry Run)...\n');
  
  try {
    // Initialize components
    const workingDir = '/Volumes/Projects/release-management-test';
    const gitFlow = new GitFlowManager(workingDir);
    const releaseAgent = new ReleaseAgent(gitFlow, workingDir);
    
    console.log('1. Initializing release agent...');
    await releaseAgent.initialize();
    console.log('   ✅ Release agent initialized\n');
    
    console.log('2. Checking versioner availability...');
    const isVersionerAvailable = releaseAgent.isVersionerAvailable();
    console.log(`   ✅ Versioner Available: ${isVersionerAvailable}`);
    
    console.log('   📁 Current working directory:', process.cwd());
    console.log('   📁 Target directory:', '/Volumes/Projects/release-management-test\n');
    
    if (!isVersionerAvailable) {
      console.log('⚠️  Versioner not available - testing git functionality only');
      
      // Test just the git parts
      console.log('3. Testing git branch synchronization...');
      const syncResult = await gitFlow.verifyMainDevelopSync();
      console.log(`   ✅ Can Proceed: ${syncResult.canProceed}`);
      console.log(`   ✅ Message: ${syncResult.message}\n`);
      
      console.log('🎉 Git functionality test completed successfully!');
      return;
    }
    
    console.log('3. Executing minor RC workflow (dry run)...');
    const workflowResult = await releaseAgent.executeMinorRCWorkflow('/Volumes/Projects/release-management-test', true);
    
    console.log('\n📋 Workflow Results:');
    console.log(`   Working Directory: ${workflowResult.workingDirectory}`);
    console.log(`   Current Branch: ${workflowResult.currentBranch}`);
    console.log(`   Dry Run: ${workflowResult.dryRun}`);
    
    console.log('\n📋 Step Progress:');
    workflowResult.stepProgress.forEach(step => {
      const statusIcon = {
        pending: '⏳',
        in_progress: '🔄',
        completed: '✅',
        failed: '❌'
      }[step.status];
      
      console.log(`   ${statusIcon} Step ${step.step}: ${step.name}`);
      if (step.message) {
        console.log(`      ${step.message}`);
      }
    });
    
    console.log('\n🎉 Minor RC Workflow test completed successfully!');
    
  } catch (error) {
    console.error('❌ Workflow test failed:', error.message);
    process.exit(1);
  }
}

testWorkflow();