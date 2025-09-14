import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Calculator, Download, FileText, BarChart3, Server, Database, Settings, TrendingUp, Cloud, Info } from 'lucide-react';

// Constants
const ENVIRONMENTS = ['dev', 'tst', 'pre', 'prd'];
const ENVIRONMENT_LABELS = {
  dev: 'Development',
  tst: 'Testing', 
  pre: 'Staging',
  prd: 'Production'
};

const BUSINESS_DOMAINS = {
  cust: {
    name: 'Customer',
    subdomains: ['marketing', 'customer_engagement_and_personalisation', 'customer_management', 'sales', 'loyalty']
  },
  comm: {
    name: 'Commercial',
    subdomains: ['trading_and_revenue_management', 'network_and_scheduling', 'commercial_partnerships', 'passenger_reservation_and_management', 'product_and_offer_management']
  },
  corp: {
    name: 'Corporate',
    subdomains: ['people', 'facilities', 'finance_and_risk', 'legal_and_compliance']
  },
  aops: {
    name: 'Airline Operations',
    subdomains: ['airport_operations', 'engineering_and_safety', 'scheduling_and_crew_rostering', 'aircraft_and_crew_management', 'flight_operations']
  },
  hols: {
    name: 'easyJet Holidays',
    subdomains: ['search_compare', 'itinerary', 'scheduling', 'payment', 'availability', 'booking', 'notification', 'support']
  }
};

// Confluent Cloud ECKU pricing tiers (GBP)
const CONFLUENT_ECKU_PRICING = {
  basic: {
    name: 'Basic',
    ecku: 1,
    monthlyPrice: 75, // ~£75/month per ECKU
    throughput: '100 MB/s',
    maxPartitions: 4000,
    maxConnections: 100,
    retention: '30 days'
  },
  standard: {
    name: 'Standard',
    ecku: 2,
    monthlyPrice: 150,
    throughput: '250 MB/s',
    maxPartitions: 4000,
    maxConnections: 500,
    retention: '90 days'
  },
  dedicated: {
    name: 'Dedicated',
    ecku: 4,
    monthlyPrice: 300,
    throughput: '500 MB/s',
    maxPartitions: 10000,
    maxConnections: 1000,
    retention: '365 days'
  }
};

// Storage pricing (per GB/month in GBP)
const CONFLUENT_STORAGE_PRICING = {
  basic: 0.08, // £0.08 per GB/month
  standard: 0.10,
  dedicated: 0.12
};

const ConfluentKafkaSizingCalculator = () => {
  const [activeTab, setActiveTab] = useState('inputs');
  const [clusterMode, setClusterMode] = useState('single');
  const [selectedDomain, setSelectedDomain] = useState('cust');
  const [inputs, setInputs] = useState({});
  const [results, setResults] = useState({});
  const [lastSaved, setLastSaved] = useState(null);

  // Initialize default inputs
  const initializeInputs = useCallback(() => {
    const defaultInputs = {};
    Object.keys(BUSINESS_DOMAINS).forEach(domain => {
      defaultInputs[domain] = {
        messagesPerSecond: 1000,
        avgMessageSize: 1024,
        retentionDays: 7,
        replicationFactor: 3,
        partitionsPerTopic: 6,
        topicsCount: BUSINESS_DOMAINS[domain].subdomains.length * 2, // 2 topics per subdomain
        peakMultiplier: 2.5,
        compressionRatio: 0.65,
        durabilityLevel: 'standard',
        environments: {
          dev: { scale: 0.1, enabled: true },
          tst: { scale: 0.3, enabled: true },
          pre: { scale: 0.7, enabled: true },
          prd: { scale: 1.0, enabled: true }
        }
      };
    });
    return defaultInputs;
  }, []);

  // Load saved data
  const loadSavedData = useCallback(() => {
    const storageKey = 'confluent-kafka-sizing-data';
    let savedData = null;
    
    try {
      // Try to load from localStorage if available
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem(storageKey);
        if (stored) {
          savedData = JSON.parse(stored);
        }
      }
    } catch (e) {
      console.log('localStorage not available, using memory storage');
    }
    
    if (savedData && savedData.inputs) {
      setInputs(savedData.inputs);
      setClusterMode(savedData.clusterMode || 'single');
      setLastSaved(new Date(savedData.timestamp));
    } else {
      setInputs(initializeInputs());
    }
  }, [initializeInputs]);

  // Save data
  const saveData = useCallback(() => {
    const dataToSave = {
      inputs,
      clusterMode,
      timestamp: new Date().toISOString()
    };
    
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('confluent-kafka-sizing-data', JSON.stringify(dataToSave));
        setLastSaved(new Date());
      }
    } catch (e) {
      console.log('Unable to save to localStorage');
    }
  }, [inputs, clusterMode]);

  // Calculate ECKU requirements
  const calculateECKUs = useCallback((throughputMBps, partitions, durabilityLevel) => {
    let requiredECKUs = 1;
    let tier = 'basic';
    
    // Calculate based on throughput
    if (throughputMBps > 400 || partitions > 8000) {
      requiredECKUs = Math.ceil(throughputMBps / 500) * 4;
      tier = 'dedicated';
    } else if (throughputMBps > 200 || partitions > 3000) {
      requiredECKUs = Math.ceil(throughputMBps / 250) * 2;
      tier = 'standard';
    } else {
      requiredECKUs = Math.ceil(throughputMBps / 100);
      tier = 'basic';
    }
    
    // Adjust for durability requirements
    if (durabilityLevel === 'dedicated') {
      tier = 'dedicated';
      requiredECKUs = Math.max(requiredECKUs, 4);
    }
    
    return { ecku: requiredECKUs, tier };
  }, []);

  // Calculate sizing requirements
  const calculateSizing = useCallback(() => {
    const newResults = {};

    Object.keys(inputs).forEach(domain => {
      const domainInput = inputs[domain];
      newResults[domain] = {};

      ENVIRONMENTS.forEach(env => {
        if (!domainInput.environments[env].enabled) return;

        const scale = domainInput.environments[env].scale;
        const scaledMps = domainInput.messagesPerSecond * scale;
        const scaledPeakMps = scaledMps * domainInput.peakMultiplier;
        
        // Calculate throughput requirements
        const throughputMBps = (scaledPeakMps * domainInput.avgMessageSize) / (1024 * 1024);
        const compressedThroughput = throughputMBps * domainInput.compressionRatio;
        
        // Calculate storage requirements
        const dailyDataGB = (scaledMps * domainInput.avgMessageSize * 86400) / (1024 * 1024 * 1024);
        const compressedDailyDataGB = dailyDataGB * domainInput.compressionRatio;
        const totalStorageGB = compressedDailyDataGB * domainInput.retentionDays * domainInput.replicationFactor;
        
        // Calculate partitions
        const totalPartitions = domainInput.topicsCount * domainInput.partitionsPerTopic;
        
        // Calculate ECKU requirements
        const eckuCalc = calculateECKUs(compressedThroughput, totalPartitions, domainInput.durabilityLevel);
        
        // Get pricing tier
        const pricingTier = CONFLUENT_ECKU_PRICING[eckuCalc.tier];
        
        // Calculate costs
        const monthlyECKUCost = (eckuCalc.ecku / pricingTier.ecku) * pricingTier.monthlyPrice;
        const monthlyStorageCost = totalStorageGB * CONFLUENT_STORAGE_PRICING[eckuCalc.tier];
        const totalMonthlyCost = monthlyECKUCost + monthlyStorageCost;
        
        // Calculate annual costs
        const annualCost = totalMonthlyCost * 12;

        newResults[domain][env] = {
          throughputMBps: compressedThroughput,
          rawThroughputMBps: throughputMBps,
          storageGB: totalStorageGB,
          rawStorageGB: totalStorageGB / domainInput.compressionRatio,
          partitions: totalPartitions,
          topics: domainInput.topicsCount,
          ecku: eckuCalc.ecku,
          tier: eckuCalc.tier,
          tierDetails: pricingTier,
          costs: {
            monthly: totalMonthlyCost,
            annual: annualCost,
            ecku: monthlyECKUCost,
            storage: monthlyStorageCost
          },
          scalingFactors: {
            scale,
            peakMultiplier: domainInput.peakMultiplier,
            compressionRatio: domainInput.compressionRatio
          }
        };
      });
    });

    setResults(newResults);
  }, [inputs, calculateECKUs]);

  // Update inputs
  const updateInput = (domain, field, value) => {
    setInputs(prev => ({
      ...prev,
      [domain]: {
        ...prev[domain],
        [field]: value
      }
    }));
  };

  const updateEnvironmentInput = (domain, env, field, value) => {
    setInputs(prev => ({
      ...prev,
      [domain]: {
        ...prev[domain],
        environments: {
          ...prev[domain].environments,
          [env]: {
            ...prev[domain].environments[env],
            [field]: value
          }
        }
      }
    }));
  };

  // Calculate totals
  const totals = useMemo(() => {
    let totalCost = 0;
    let totalECKUs = 0;
    let totalStorage = 0;
    const domainTotals = {};
    const environmentTotals = {};
    
    Object.keys(results).forEach(domain => {
      domainTotals[domain] = 0;
      Object.keys(results[domain]).forEach(env => {
        const result = results[domain][env];
        
        if (clusterMode === 'single') {
          // For single cluster, take maximum requirements
          totalECKUs = Math.max(totalECKUs, result.ecku);
          totalStorage = Math.max(totalStorage, result.storageGB);
        } else {
          // For domain clusters, sum all requirements
          totalECKUs += result.ecku;
          totalStorage += result.storageGB;
        }
        
        totalCost += result.costs.monthly;
        domainTotals[domain] += result.costs.monthly;
        
        if (!environmentTotals[env]) environmentTotals[env] = 0;
        environmentTotals[env] += result.costs.monthly;
      });
    });

    return { 
      totalCost, 
      totalECKUs, 
      totalStorage, 
      domainTotals, 
      environmentTotals,
      annualCost: totalCost * 12
    };
  }, [results, clusterMode]);

  // Export functions
  const exportToCSV = () => {
    const csvData = [];
    csvData.push([
      'Domain', 'Environment', 'Throughput (MB/s)', 'Storage (GB)', 
      'Topics', 'Partitions', 'ECKUs', 'Tier', 'Monthly Cost (£)', 'Annual Cost (£)'
    ]);
    
    Object.keys(results).forEach(domain => {
      Object.keys(results[domain]).forEach(env => {
        const result = results[domain][env];
        csvData.push([
          BUSINESS_DOMAINS[domain].name,
          ENVIRONMENT_LABELS[env],
          result.throughputMBps.toFixed(2),
          result.storageGB.toFixed(0),
          result.topics,
          result.partitions,
          result.ecku,
          result.tier,
          result.costs.monthly.toFixed(2),
          result.costs.annual.toFixed(2)
        ]);
      });
    });

    const csvContent = csvData.map(row => row.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `confluent-kafka-sizing-${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
  };

  const exportToPDF = () => {
    // Create a simple HTML content for PDF export
    const htmlContent = `
      <html>
        <head>
          <title>Confluent Kafka Sizing Report</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 20px; }
            h1 { color: #1f2937; }
            h2 { color: #374151; border-bottom: 2px solid #e5e7eb; }
            table { width: 100%; border-collapse: collapse; margin: 20px 0; }
            th, td { border: 1px solid #d1d5db; padding: 8px; text-align: left; }
            th { background-color: #f9fafb; }
            .summary { background-color: #eff6ff; padding: 15px; border-radius: 8px; margin: 20px 0; }
          </style>
        </head>
        <body>
          <h1>Confluent Cloud Kafka Sizing Report</h1>
          <div class="summary">
            <h3>Summary</h3>
            <p>Total Monthly Cost: £${totals.totalCost.toFixed(2)}</p>
            <p>Total Annual Cost: £${totals.annualCost.toFixed(2)}</p>
            <p>Total ECKUs: ${totals.totalECKUs}</p>
            <p>Total Storage: ${totals.totalStorage.toFixed(0)} GB</p>
            <p>Cluster Mode: ${clusterMode === 'single' ? 'Single Shared Cluster' : 'Cluster per Domain'}</p>
          </div>
          <table>
            <thead>
              <tr>
                <th>Domain</th>
                <th>Environment</th>
                <th>Throughput (MB/s)</th>
                <th>Storage (GB)</th>
                <th>ECKUs</th>
                <th>Tier</th>
                <th>Monthly Cost (£)</th>
              </tr>
            </thead>
            <tbody>
              ${Object.keys(results).map(domain => 
                Object.keys(results[domain]).map(env => {
                  const result = results[domain][env];
                  return `
                    <tr>
                      <td>${BUSINESS_DOMAINS[domain].name}</td>
                      <td>${ENVIRONMENT_LABELS[env]}</td>
                      <td>${result.throughputMBps.toFixed(2)}</td>
                      <td>${result.storageGB.toFixed(0)}</td>
                      <td>${result.ecku}</td>
                      <td>${result.tier}</td>
                      <td>£${result.costs.monthly.toFixed(2)}</td>
                    </tr>
                  `;
                }).join('')
              ).join('')}
            </tbody>
          </table>
        </body>
      </html>
    `;

    const blob = new Blob([htmlContent], { type: 'text/html' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `confluent-kafka-sizing-report-${new Date().toISOString().split('T')[0]}.html`;
    link.click();
  };

  // Initialize on mount
  useEffect(() => {
    loadSavedData();
  }, [loadSavedData]);

  // Save data when inputs change
  useEffect(() => {
    if (Object.keys(inputs).length > 0) {
      saveData();
    }
  }, [inputs, clusterMode, saveData]);

  // Calculate results when inputs change
  useEffect(() => {
    if (Object.keys(inputs).length > 0) {
      calculateSizing();
    }
  }, [inputs, calculateSizing]);

  // Render input form for selected domain
  const renderDomainInputs = () => {
    if (!inputs[selectedDomain]) return null;

    const domainInput = inputs[selectedDomain];

    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="p-3 bg-blue-100 rounded-lg">
            <Database className="w-8 h-8 text-blue-600" />
          </div>
          <div>
            <h3 className="text-2xl font-bold text-gray-800">{BUSINESS_DOMAINS[selectedDomain].name}</h3>
            <p className="text-gray-600">{BUSINESS_DOMAINS[selectedDomain].subdomains.length} subdomains</p>
          </div>
        </div>

        {/* Core Configuration */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-4 text-gray-800">Core Configuration</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Messages per Second (Base Load)
              </label>
              <input
                type="number"
                value={domainInput.messagesPerSecond}
                onChange={(e) => updateInput(selectedDomain, 'messagesPerSecond', parseInt(e.target.value) || 0)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="0"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Average Message Size (bytes)
              </label>
              <input
                type="number"
                value={domainInput.avgMessageSize}
                onChange={(e) => updateInput(selectedDomain, 'avgMessageSize', parseInt(e.target.value) || 0)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="1"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Retention Days
              </label>
              <input
                type="number"
                value={domainInput.retentionDays}
                onChange={(e) => updateInput(selectedDomain, 'retentionDays', parseInt(e.target.value) || 1)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="1"
                max="365"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Replication Factor
              </label>
              <select
                value={domainInput.replicationFactor}
                onChange={(e) => updateInput(selectedDomain, 'replicationFactor', parseInt(e.target.value))}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value={1}>1 (Development only)</option>
                <option value={3}>3 (Recommended)</option>
                <option value={5}>5 (High Availability)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Peak Load Multiplier
              </label>
              <input
                type="number"
                step="0.1"
                value={domainInput.peakMultiplier}
                onChange={(e) => updateInput(selectedDomain, 'peakMultiplier', parseFloat(e.target.value) || 1)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="1"
                max="10"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Compression Ratio
              </label>
              <select
                value={domainInput.compressionRatio}
                onChange={(e) => updateInput(selectedDomain, 'compressionRatio', parseFloat(e.target.value))}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value={1.0}>None (1.0)</option>
                <option value={0.8}>Low (0.8)</option>
                <option value={0.65}>Medium (0.65)</option>
                <option value={0.5}>High (0.5)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Topic Configuration */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-4 text-gray-800">Topic Configuration</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Number of Topics
              </label>
              <input
                type="number"
                value={domainInput.topicsCount}
                onChange={(e) => updateInput(selectedDomain, 'topicsCount', parseInt(e.target.value) || 1)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="1"
              />
              <p className="text-xs text-gray-500 mt-1">
                Suggested: {BUSINESS_DOMAINS[selectedDomain].subdomains.length * 2} (2 per subdomain)
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Partitions per Topic
              </label>
              <input
                type="number"
                value={domainInput.partitionsPerTopic}
                onChange={(e) => updateInput(selectedDomain, 'partitionsPerTopic', parseInt(e.target.value) || 1)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                min="1"
                max="100"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Durability Level
              </label>
              <select
                value={domainInput.durabilityLevel}
                onChange={(e) => updateInput(selectedDomain, 'durabilityLevel', e.target.value)}
                className="w-full p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="basic">Basic</option>
                <option value="standard">Standard</option>
                <option value="dedicated">Dedicated</option>
              </select>
            </div>
          </div>
        </div>

        {/* Environment Scaling */}
        <div className="bg-gray-50 rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-4 text-gray-800">Environment Scaling Factors</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {ENVIRONMENTS.map(env => (
              <div key={env} className="bg-white border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <label className="font-medium text-sm text-gray-700">
                    {ENVIRONMENT_LABELS[env]}
                  </label>
                  <input
                    type="checkbox"
                    checked={domainInput.environments[env].enabled}
                    onChange={(e) => updateEnvironmentInput(selectedDomain, env, 'enabled', e.target.checked)}
                    className="w-4 h-4 text-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Scale Factor</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0.1"
                    max="2.0"
                    value={domainInput.environments[env].scale}
                    onChange={(e) => updateEnvironmentInput(selectedDomain, env, 'scale', parseFloat(e.target.value) || 0.1)}
                    disabled={!domainInput.environments[env].enabled}
                    className="w-full p-2 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-100"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Topic Structure Preview */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
          <h4 className="text-lg font-semibold mb-4 text-blue-800">
            <Info className="w-5 h-5 inline mr-2" />
            Recommended Topic Structure
          </h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <h5 className="font-medium text-blue-700 mb-2">Event Topics</h5>
              <div className="space-y-1">
                {BUSINESS_DOMAINS[selectedDomain].subdomains.slice(0, 3).map(subdomain => (
                  <div key={subdomain} className="text-sm font-mono bg-white px-3 py-2 rounded border border-blue-200">
                    {selectedDomain}.{subdomain}.events.v1
                  </div>
                ))}
                {BUSINESS_DOMAINS[selectedDomain].subdomains.length > 3 && (
                  <div className="text-xs text-blue-600 pl-3">
                    ... and {BUSINESS_DOMAINS[selectedDomain].subdomains.length - 3} more
                  </div>
                )}
              </div>
            </div>
            <div>
              <h5 className="font-medium text-blue-700 mb-2">Command Topics</h5>
              <div className="space-y-1">
                {BUSINESS_DOMAINS[selectedDomain].subdomains.slice(0, 3).map(subdomain => (
                  <div key={subdomain} className="text-sm font-mono bg-white px-3 py-2 rounded border border-blue-200">
                    {selectedDomain}.{subdomain}.commands.v1
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <header className="mb-8 text-center">
          <div className="flex items-center justify-center gap-3 mb-4">
            <Cloud className="w-12 h-12 text-blue-600" />
            <div>
              <h1 className="text-4xl font-bold text-gray-800">Confluent Cloud Kafka Sizing Calculator</h1>
              <p className="text-blue-600 font-medium">ECKU-based Capacity Planning</p>
            </div>
          </div>
          <p className="text-gray-600 text-lg">Optimize your Confluent Cloud Kafka clusters for performance and cost</p>
          {lastSaved && (
            <p className="text-sm text-gray-500 mt-2">
              Last saved: {lastSaved.toLocaleString()}
            </p>
          )}
        </header>

        {/* Cluster Mode Selection */}
        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h3 className="text-lg font-semibold mb-4 flex items-center">
            <Settings className="w-5 h-5 mr-2" />
            Cluster Architecture
          </h3>
          <div className="flex gap-6">
            <label className="flex items-center cursor-pointer">
              <input
                type="radio"
                value="single"
                checked={clusterMode === 'single'}
                onChange={(e) => setClusterMode(e.target.value)}
                className="mr-3 w-4 h-4 text-blue-600"
              />
              <div>
                <div className="font-medium">Single Shared Cluster</div>
                <div className="text-sm text-gray-600">All domains share one cluster</div>
              </div>
            </label>
            <label className="flex items-center cursor-pointer">
              <input
                type="radio"
                value="domain"
                checked={clusterMode === 'domain'}
                onChange={(e) => setClusterMode(e.target.value)}
                className="mr-3 w-4 h-4 text-blue-600"
              />
              <div>
                <div className="font-medium">Cluster per Business Domain</div>
                <div className="text-sm text-gray-600">Isolated clusters for each domain</div>
              </div>
            </label>
          </div>
        </div>

        {/* Main Content */}
        <div className="bg-white rounded-lg shadow-lg overflow-hidden">
          {/* Tab Navigation */}
          <div className="border-b border-gray-200">
            <nav className="flex">
              {[
                { id: 'inputs', label: 'Domain Inputs', icon: Database },
                { id: 'results', label: 'Sizing Results', icon: BarChart3 },
                { id: 'summary', label: 'Cost Summary', icon: TrendingUp }
              ].map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-6 py-4 text-sm font-medium flex items-center gap-2 ${
                    activeTab === tab.id
                      ? 'border-b-2 border-blue-500 text-blue-600 bg-blue-50'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="p-6">
            {/* Inputs Tab */}
            {activeTab === 'inputs' && (
              <div className="space-y-6">
                {/* Domain Selector */}
                <div className="bg-gray-50 rounded-lg p-4">
                  <h3 className="text-lg font-semibold mb-4">Select Business Domain</h3>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                    {Object.keys(BUSINESS_DOMAINS).map(domain => (
                      <button
                        key={domain}
                        onClick={() => setSelectedDomain(domain)}
                        className={`p-3 text-left rounded-lg border transition-all ${
                          selectedDomain === domain
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-gray-200 bg-white hover:border-gray-300'
                        }`}
                      >
                        <div className="font-medium text-sm">{BUSINESS_DOMAINS[domain].name}</div>
                        <div className="text-xs text-gray-500 uppercase">{domain}</div>
                        <div className="text-xs text-gray-400 mt-1">
                          {BUSINESS_DOMAINS[domain].subdomains.length} subdomains
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Domain Inputs */}
                {renderDomainInputs()}
              </div>
            )}

            {/* Results Tab */}
            {activeTab === 'results' && (
              <div className="space-y-8">
                <div className="flex justify-between items-center">
                  <h3 className="text-2xl font-bold text-gray-800 flex items-center">
                    <BarChart3 className="w-8 h-8 mr-3 text-blue-600" />
                    ECKU Sizing Results
                  </h3>
                  <div className="flex gap-3">
                    <button
                      onClick={exportToCSV}
                      className="flex items-center gap-2 px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                    >
                      <Download className="w-4 h-4" />
                      Export CSV
                    </button>
                    <button
                      onClick={exportToPDF}
                      className="flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
                    >
                      <FileText className="w-4 h-4" />
                      Export HTML
                    </button>
                  </div>
                </div>

                {Object.keys(results).map(domain => (
                  <div key={domain} className="border border-gray-200 rounded-lg overflow-hidden">
                    <div className="bg-gradient-to-r from-blue-50 to-indigo-50 px-6 py-4 border-b border-gray-200">
                      <h4 className="text-xl font-semibold text-gray-800 flex items-center">
                        <Database className="w-6 h-6 mr-2 text-blue-600" />
                        {BUSINESS_DOMAINS[domain].name} ({domain.toUpperCase()})
                      </h4>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full">
                        <thead className="bg-gray-50">
                          <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Environment</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Throughput</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Storage</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Topics/Partitions</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">ECKUs</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Tier</th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Monthly Cost</th>
                          </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                          {Object.keys(results[domain] || {}).map(env => {
                            const result = results[domain][env];
                            return (
                              <tr key={env} className="hover:bg-gray-50">
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="flex items-center">
                                    <div className={`w-3 h-3 rounded-full mr-2 ${
                                      env === 'prd' ? 'bg-red-400' : 
                                      env === 'pre' ? 'bg-orange-400' : 
                                      env === 'tst' ? 'bg-yellow-400' : 'bg-green-400'
                                    }`}></div>
                                    <span className="text-sm font-medium text-gray-900">
                                      {ENVIRONMENT_LABELS[env]}
                                    </span>
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                  <div>{result.throughputMBps.toFixed(1)} MB/s</div>
                                  <div className="text-xs text-gray-500">
                                    ({result.rawThroughputMBps.toFixed(1)} raw)
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                  <div>{result.storageGB.toFixed(0)} GB</div>
                                  <div className="text-xs text-gray-500">
                                    ({result.rawStorageGB.toFixed(0)} raw)
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                  <div>{result.topics} topics</div>
                                  <div className="text-xs text-gray-500">
                                    {result.partitions} partitions
                                  </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 font-medium">
                                  {result.ecku} ECKUs
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
                                    result.tier === 'dedicated' ? 'bg-purple-100 text-purple-800' :
                                    result.tier === 'standard' ? 'bg-blue-100 text-blue-800' :
                                    'bg-green-100 text-green-800'
                                  }`}>
                                    {result.tier}
                                  </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                  <div className="text-sm font-medium text-green-600">
                                    £{result.costs.monthly.toFixed(2)}
                                  </div>
                                  <div className="text-xs text-gray-500">
                                    £{result.costs.annual.toFixed(0)}/year
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Summary Tab */}
            {activeTab === 'summary' && (
              <div className="space-y-8">
                <h3 className="text-2xl font-bold text-gray-800 flex items-center">
                  <TrendingUp className="w-8 h-8 mr-3 text-blue-600" />
                  Cost & Resource Summary
                </h3>

                {/* Key Metrics Cards */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                  <div className="bg-gradient-to-br from-blue-50 to-blue-100 border border-blue-200 rounded-lg p-6">
                    <div className="flex items-center">
                      <div className="p-3 bg-blue-500 rounded-lg">
                        <FileText className="w-6 h-6 text-white" />
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-blue-600">Monthly Total</p>
                        <p className="text-2xl font-bold text-blue-900">£{totals.totalCost.toFixed(0)}</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gradient-to-br from-green-50 to-green-100 border border-green-200 rounded-lg p-6">
                    <div className="flex items-center">
                      <div className="p-3 bg-green-500 rounded-lg">
                        <Server className="w-6 h-6 text-white" />
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-green-600">Total ECKUs</p>
                        <p className="text-2xl font-bold text-green-900">{totals.totalECKUs}</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gradient-to-br from-purple-50 to-purple-100 border border-purple-200 rounded-lg p-6">
                    <div className="flex items-center">
                      <div className="p-3 bg-purple-500 rounded-lg">
                        <Database className="w-6 h-6 text-white" />
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-purple-600">Total Storage</p>
                        <p className="text-2xl font-bold text-purple-900">{totals.totalStorage.toFixed(0)} GB</p>
                      </div>
                    </div>
                  </div>

                  <div className="bg-gradient-to-br from-orange-50 to-orange-100 border border-orange-200 rounded-lg p-6">
                    <div className="flex items-center">
                      <div className="p-3 bg-orange-500 rounded-lg">
                        <Calculator className="w-6 h-6 text-white" />
                      </div>
                      <div className="ml-4">
                        <p className="text-sm font-medium text-orange-600">Annual Total</p>
                        <p className="text-2xl font-bold text-orange-900">£{totals.annualCost.toFixed(0)}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cluster Architecture Info */}
                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg p-6">
                  <h4 className="text-lg font-semibold text-blue-800 mb-3 flex items-center">
                    <Cloud className="w-5 h-5 mr-2" />
                    Confluent Cloud Architecture
                  </h4>
                  <div className="grid md:grid-cols-2 gap-6">
                    <div>
                      <p className="text-blue-700 mb-2">
                        <strong>Cluster Mode:</strong> {clusterMode === 'single' ? 'Single Shared Cluster' : 'Domain-Isolated Clusters'}
                      </p>
                      <p className="text-blue-600 text-sm">
                        {clusterMode === 'single' 
                          ? 'All business domains share a single Confluent Cloud cluster. ECKUs calculated based on peak aggregate requirements.'
                          : 'Each business domain has its own dedicated Confluent Cloud cluster for complete isolation and independent scaling.'
                        }
                      </p>
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-600">Total Business Domains:</span>
                        <span className="font-medium">{Object.keys(BUSINESS_DOMAINS).length}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-600">Active Environments:</span>
                        <span className="font-medium">{ENVIRONMENTS.length}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-600">Provider:</span>
                        <span className="font-medium">Confluent Cloud SaaS</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Cost Breakdown by Domain */}
                <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                  <div className="bg-gray-50 px-6 py-4 border-b border-gray-200">
                    <h4 className="text-xl font-semibold text-gray-800">Cost Breakdown by Business Domain</h4>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Business Domain</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">DEV</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">TST</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PRE</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">PRD</th>
                          <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Domain Total</th>
                        </tr>
                      </thead>
                      <tbody className="bg-white divide-y divide-gray-200">
                        {Object.keys(BUSINESS_DOMAINS).map(domain => {
                          const domainCosts = {};
                          let domainTotal = 0;
                          
                          ENVIRONMENTS.forEach(env => {
                            if (results[domain]?.[env]) {
                              domainCosts[env] = results[domain][env].costs.monthly;
                              domainTotal += results[domain][env].costs.monthly;
                            } else {
                              domainCosts[env] = 0;
                            }
                          });

                          return (
                            <tr key={domain} className="hover:bg-gray-50">
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                <div className="flex items-center">
                                  <Database className="w-4 h-4 mr-2 text-gray-500" />
                                  {BUSINESS_DOMAINS[domain].name}
                                </div>
                                <div className="text-xs text-gray-500 mt-1">
                                  {domain.toUpperCase()}
                                </div>
                              </td>
                              {ENVIRONMENTS.map(env => (
                                <td key={env} className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                                  {domainCosts[env] > 0 ? `£${domainCosts[env].toFixed(2)}` : '—'}
                                </td>
                              ))}
                              <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-green-600">
                                £{domainTotal.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })}
                        <tr className="bg-gray-50 border-t-2 border-gray-300">
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-gray-900">
                            Environment Totals
                          </td>
                          {ENVIRONMENTS.map(env => (
                            <td key={env} className="px-6 py-4 whitespace-nowrap text-sm font-bold text-blue-600">
                              £{(totals.environmentTotals[env] || 0).toFixed(2)}
                            </td>
                          ))}
                          <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-green-700">
                            £{totals.totalCost.toFixed(2)}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* ECKU Pricing Reference */}
                <div className="grid md:grid-cols-3 gap-6">
                  {Object.entries(CONFLUENT_ECKU_PRICING).map(([tier, pricing]) => (
                    <div key={tier} className="bg-white border border-gray-200 rounded-lg p-6">
                      <div className="flex items-center justify-between mb-4">
                        <h5 className="text-lg font-semibold text-gray-800 capitalize">{pricing.name}</h5>
                        <span className={`px-2 py-1 text-xs font-medium rounded-full ${
                          tier === 'dedicated' ? 'bg-purple-100 text-purple-800' :
                          tier === 'standard' ? 'bg-blue-100 text-blue-800' :
                          'bg-green-100 text-green-800'
                        }`}>
                          {pricing.ecku} ECKU{pricing.ecku > 1 ? 's' : ''}
                        </span>
                      </div>
                      <div className="space-y-2 text-sm">
                        <div className="flex justify-between">
                          <span className="text-gray-600">Monthly Cost:</span>
                          <span className="font-medium">£{pricing.monthlyPrice}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Throughput:</span>
                          <span className="font-medium">{pricing.throughput}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Max Partitions:</span>
                          <span className="font-medium">{pricing.maxPartitions.toLocaleString()}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-gray-600">Retention:</span>
                          <span className="font-medium">{pricing.retention}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* Best Practices */}
                <div className="bg-green-50 border border-green-200 rounded-lg p-6">
                  <h4 className="text-lg font-semibold text-green-800 mb-4">Confluent Cloud Best Practices</h4>
                  <div className="grid md:grid-cols-2 gap-6">
                    <div>
                      <h5 className="font-medium text-green-700 mb-2">Topic Design</h5>
                      <ul className="space-y-1 text-sm text-green-600">
                        <li>• Use consistent naming: {`{domain}.{subdomain}.{type}.v{version}`}</li>
                        <li>• Plan partition count for scaling (6-12 partitions typical)</li>
                        <li>• Set appropriate retention based on business needs</li>
                        <li>• Use Schema Registry for data governance</li>
                      </ul>
                    </div>
                    <div>
                      <h5 className="font-medium text-green-700 mb-2">Performance & Cost</h5>
                      <ul className="space-y-1 text-sm text-green-600">
                        <li>• Enable compression (snappy/lz4) to reduce costs</li>
                        <li>• Monitor ECKU utilization and scale accordingly</li>
                        <li>• Use dedicated clusters for production workloads</li>
                        <li>• Implement proper consumer group strategies</li>
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ConfluentKafkaSizingCalculator;