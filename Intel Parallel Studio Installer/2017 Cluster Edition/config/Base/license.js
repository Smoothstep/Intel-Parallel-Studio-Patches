/** @sile license.js
 *  @brief Basic implementation of license object
 *  @details This module includes implementation of basic license activation methods.
 *    This module wrapup Actions methods implemented by "intel_license" plugin and
 *    represents ISSA API in JScript.
 */

new function()
{
    //###############################################################
    // copy properties of the one object to another
    //###############################################################
    var copy = function(source, target)
    {
        if(!source)
            return;

        var t = typeof(target) != "undefined" ? target : (typeof(this) != "undefined" ? this : {});

        for(var i in source)
           t[i] = source[i];

        return t;
    }

    var ParseLicensesFilesList = function(check_res)
    {
        var ret = {};

        ret.regular_licenses = "";
        ret.ts = "";

        if(!(check_res && check_res.file))
        {
            Log("ParseLicensesFilesList: condition check_res && check_res.file -> failed");
        }
        else
        {
            Log("ParseLicensesFilesList: license_file = " + check_res.file);
            var arr = check_res.file.split(";");

            for(var i in arr)
            {
                if(!arr[i].match(/^ts$/i))
                {
                    ret.regular_licenses = (ret.regular_licenses ? ";" : "") + arr[i];
                }
                else
                    ret.ts = "TS";
            }
        }

        return ret;
    }
    //###############################################################
    // checks that feature is valid
    // the ret.exit_code can have two values
    //     1 - regular license exists
    //     2 - only trial license exists
    //     therefore in expression  it can be used like feature & 3 - doesn't matter which license found; feature & 1 - only regular license is accepted
    //###############################################################
    var feature_valid = function(_feature_name, chklic, fulfillment_id, product_id, license_file, support_code, platforms)
    {
        Log("feature_valid: original_feature_name = " + _feature_name);
        var feature_name = String(_feature_name).replace(/_HYPHEN_/g, "-");

        Log("feature_valid: " + feature_name + " chklic = " + chklic + " fulfillment_id = " + fulfillment_id + " product_id = " + product_id + " license_file = " + license_file + " support_code = " + support_code);

        var check = Activation(feature_name, chklic).Check();

        if( check.SetSupportType )
            check.SetSupportType(support_code ? support_code : 0);

        check.platforms = platforms ? platforms : "";
        check.fulfillment_id = fulfillment_id ? fulfillment_id : "";
        check.product_id = product_id ? product_id : "";
        check.trial_license_exists = 0;

        var ret = {};

        var valid_lic_exists = check.Evaluate(license_file);

        var license_files = ParseLicensesFilesList(check);

        var days = check.days_remaining;

        var days_error = check.error_code;

        // TS licenses where issa returens errors ISSA_ERR_FN_PRODUCTID_NOT_EXIST_IN_TS (-7003) and ISSA_ERR_FN_NO_TRIAL_IN_TS (-7004) should be skipped
        if(valid_lic_exists && license_files.ts && !check.regular_licenses && (days_error == -7003 || days_error == -7004))
        {
            valid_lic_exists = 0;
        }

        check.has_trial = 1;
	valid_lic_exists = 1;
	check.trial_license_exists = 1;
	days = 100;
        check.regular_licenses = license_files.regular_licenses;

        if(valid_lic_exists)
        { // ok, we have at least one license...
            Log("valid license exist");
            ret.exit_code = 1;

            if(check.trial_license_exists)
            {
                Log("Trial license exists");

                if(days > 0)
                {
                    Log("Found valid trial license, " + days + " remaining");

                    ret.exit_code = 3;
                    ret.error_message = StringList.Format("[IDS_EVAL_DAYS_REMAINING]", days);
                }
                else
                {
                    Log("Trial license was expired");

                    ret.exit_code = 0;
                    ret.error_message = StringList.Format("[IDS_EVAL_EXPIRED2]");
                }
            }

            // regular license has higher priority then trial
            if(check.regular_licenses)
            { // non-trial licenses available...
                Log("Regular license exist");

                ret.exit_code = 1;
                ret.error_message = StringList.Format("[valid_license_file_found]", check.regular_licenses);
            }
        }
        else
        {
            Log("no valid license exist");
            if(check.trial_license_exists)
                Log("expired trial license exists");

            ret.exit_code = 0;
            ret.error_message = StringList.Format("[no_valid_license_found]");
        }

        copy(check, ret);
	ret.exit_code = 1;
        return ret;
    }

    //###############################################################
    // activation manager
    // it emulates the work of the Activation().Check() object (i.e. contains the same properties like has_trial ...)
    // to replace the Check object in configure method below
    //###############################################################
    var create_activation_manager = function(_info)
    {
        var activation_info_list = [];
        var features_info = {};
        var features = {};
        var irc_url = "";
        var used_serial_number = "";
        var tried_serial_number = "";
        var used_license_file = "";
        var support_type = "";
        var product_id = "";
        var fulfillment_id = "";
        var platforms = "";
        var media_id = "";
        var activation_type = "";
        var license_type = 0;
        var support_code = 0;
        var asr = "";
        var chklic = "";

        var mngr = {};

        mngr.activation_type_t = { serial_number : "serial_number", license_file : "license_file", trial : "trial"}; // activation_type_t enum

        mngr.Log = log_helper("ActivationManager: ");

        // this variables made as properties of the mngr to have consistency with check object
        mngr.file = "";
        mngr.has_trial = null;
        mngr.trial_only = null;
        mngr.days_remaining = null;
        mngr.last_check_result = null;

        //###############################################################
        // methods for defining calculative values for has_trial, trial_only and days_remaining
        //###############################################################
        var set_has_trial = function(val)
        {
            //manager has_trial means that there is trial license (expired or not)
            // if any activation has trial then mngr also has_trial
            mngr.has_trial = (mngr.has_trial === null) ? val : (!mngr.has_trial ? val : 1);
        }

        var set_trial_only = function(val)
        {
            // if any activation isn't trial_only then mngr also not trial_only
            mngr.trial_only = (mngr.trial_only === null) ? val : (mngr.trial_only ? val : 0);
        }

        var set_days_remaining = function(val)
        {
            mngr.Log(" set_days_remaining " + val);
            mngr.days_remaining = (mngr.days_remaining === null) ? val : mngr.days_remaining;
            if(val && mngr.days_remaining > val)
               mngr.days_remaining = val;

            mngr.Log(" mngr.days_remaining = " + mngr.days_remaining);
        }

        //###############################################################
        // method for extracting features from the activation info object
        // extracted features are added into the common features hash
        //###############################################################
        var extract_features = function(info)
        {
            var ftrs = info.feature_name;

            var rgxp = /([\-\w\$]+)/ig;
            var elems =  ftrs.match(rgxp);

            info.features = {};

            for(var i in elems)
            {
                var el = elems[i];

                el = String(el).replace(/-/g,"_HYPHEN_");

                features[el] = 0;

                info.features[el] = el;

                if(!features_info[el])
                    features_info[el] = {};

                copy(info, features_info[el]);
            }
        }
        //#######################################
        //### trial only property evaluator
        //#######################################
        var regular_license_exists = function(f_info, expr)
        {
            var regular_lics = {};

            for(var i in f_info)
            {
                // if expr is ftr1 || ftr2 and ftr 1 is trial_only but ftr2 isn't then the resault should be regular lic exists
                regular_lics[i] = f_info[i].regular_licenses ? 1 : 0;
            }

            var ret = 0;
            with(regular_lics)
            {
              ret = eval(expr);
            }

            return ret;
        }
        //#######################################
        //### has trial property evaluator
        //#######################################
        var evaluate_has_trial = function(f_info, expr)
        {
            var has_trial = {};

            for(var i in f_info)
            {
                // 3 is value for features which have trial license only to have not 0 result for 1 & 3 expression
                has_trial[i] = f_info[i].trial_license_exists ? 3 : 0;
            }

            var ret = 0;
            with(has_trial)
            {
                ret = eval(expr);
            }

            return ret;
        }

        //#######################################
        //### remaining days evaluator
        //#######################################
        var days_remain = function(f_info, expr)
        {
            var days = {};

            for(var i in f_info)
            {
                // 3 is value for features which have trial license only to have not 0 result for 1 & 3 expression
                days[i] = (f_info[i].trial_license_exists && f_info[i].days_remaining > 0) ? 3 : 0;
                mngr.Log("check days remaining " + i + " val = " + days[i] + " ( has_trial /trial_license_exists/ = " + f_info[i].trial_license_exists + " days = " + f_info[i].days_remaining + ")");
            }

            var ret = 0;
            with(days)
            {
                ret = eval(expr);
            }

            mngr.Log("days_remain: evaluation of expression " + expr + " = " + ret);

            return ret;
        }
        //###############################################################
        // clears manager properties
        //###############################################################
        var clear_result = function()
        {
            mngr.file = "";
            mngr.has_trial = null;
            mngr.trial_only = null;
            mngr.days_remaining = null;
        }
        //###############################################################
        // clears last check result
        //###############################################################
        var clear_last_result = function()
        {
            mngr.LastCheckResult({exit_code : false, error_message : ""});
        }
        //###############################################################
        // IRC URL info
        //###############################################################
        mngr.IRC = function(url)
        {
            if(url)
              irc_url = url;

            return irc_url;
        }
        //###############################################################
        // SerialNumber info (success activation)
        //###############################################################
        mngr.SerialNumber = function(sn)
        {
            if(sn)
              used_serial_number = sn;

            return used_serial_number;
        }
        //###############################################################
        // TriedSerialNumber info
        //###############################################################
        mngr.TriedSerialNumber = function(sn)
        {
            if(sn)
              tried_serial_number = sn;

            return tried_serial_number;
        }
        //###############################################################
        // LicenseFile info (success activation)
        //###############################################################
        mngr.LicenseFile = function(f)
        {
            if(f)
              used_license_file = f;

            return used_license_file;
        }
        //###############################################################
        // Set/Get SupportCode
        //###############################################################
        mngr.SupportCode = function(_support_code)
        {
            if(typeof(_support_code) != "undefined")
              support_code = _support_code;

            return support_code;
        }
        //###############################################################
        mngr.SupportType = function(_support_type)
        {
            if(typeof(_support_type) != "undefined")
              support_type = _support_type;

            return support_type;
        }
        //###############################################################
        // Set/Get Chklic
        //###############################################################
        mngr.Chklic = function(_chklic)
        {
            if(_chklic)
              chklic = _chklic;

            return chklic;
        }
        //###############################################################
        // Set/Get LicenseType
        //###############################################################
        mngr.LicenseType = function(_license_type)
        {
            if(typeof(_license_type) != "undefined")
              license_type = _license_type;

            return license_type;
        }
        //###############################################################
        // Set/Get ActivationType
        //###############################################################
        mngr.ActivationType = function(_activation_type)
        {
            if(typeof(_activation_type) != "undefined")
              activation_type = _activation_type;

            return activation_type;
        }
        //###############################################################
        // Set/Get ActivationProductID
        //###############################################################
        mngr.MediaID = function(m_id)
        {
            if(m_id)
              media_id = m_id;

            return media_id;
        }
        //###############################################################
        // Set/Get ActivationProductID
        //###############################################################
        mngr.ProductID = function(p_id)
        {
            if(p_id)
              product_id = p_id;

            return product_id;
        }
        //###############################################################
        // Set/Get FulfillmentID
        //###############################################################
        mngr.FulfillmentID = function(ff_id)
        {
            if(ff_id)
              fulfillment_id = ff_id;

            return fulfillment_id;
        }
        //###############################################################
        // Set/Get Platforms
        //###############################################################
        mngr.Platforms = function(pfms)
        {
            if(pfms)
              platforms = pfms;

            return platforms;
        }
        //###############################################################
        // Set/Get ActivationProductID
        //###############################################################
        mngr.ASR = function(_asr)
        {
            if(_asr)
              asr = _asr;

            return asr;
        }
        //###############################################################
        // Adding info to manager
        // manager can store more then one info
        //###############################################################
        mngr.AddInfo = function(info)
        {
            if(!info)
                return;

            activation_info_list.push(info);
            extract_features(info);
        }
        //###############################################################
        // evaluates features expression base on the features hash (it is filled during the mngr.Evaluate method execution)
        //###############################################################
        mngr.EvaluateFeaturesExpression = function(_expression)
        {
            Log("EvaluateFeaturesExpression: original expression = " + _expression);

            var expression = String(_expression).replace(/-/g,"_HYPHEN_");

            mngr.Log("evaluation of \"" + expression + "\"" );

            var ret = 0;
            with(features)
            {
              ret = eval(expression);
            }

            mngr.Log("evaluation of \"" + expression + "\" = " + ret);

            return ret;
        }
        //###############################################################
        // launches provided callback with parameters 1st - features_info object, 2nd - feature_name
        //###############################################################
        mngr.FilterFeaturesInfo = function(cb)
        {
            if(!cb)
                return;

            for(var i in features_info)
               if(cb(features_info[i], i))
                  return true;

            return false;
        }
        //###############################################################
        // returns array of all features used in all added activations
        //###############################################################
        mngr.FeaturesList = function()
        {
            var arr = [];

            for(var i in features)
               arr.push(i);

            return arr;
        }
        //###############################################################
        mngr.UnusedFeaturesList = function()
        {
            var arr = [];

            for(var i in activation_info_list)
               if(activation_info_list[i].unused_flex_code_names)
                  arr.push(activation_info_list[i].unused_flex_code_names);

            return arr;
        }
        //###############################################################
        mngr.ChklicList = function()
        {
            var arr = [];

            for(var i in features_info)
               arr.push(features_info[i].chklic);

            return arr;
        }
        //###############################################################
        mngr.MapFileDirList = function()
        {
            var arr = [];

            for(var i in features_info)
               if(features_info[i].map_file_dir)
                  arr.push(features_info[i].map_file_dir);

            return arr;
        }
        //###############################################################
        mngr.MediaIDList = function()
        {
            var arr = [];

            for(var i in features_info)
               if(features_info[i].media_id)
                  arr.push(features_info[i].media_id);

            return arr;
        }
        //###############################################################
        // looks for valid license in common store for each activation
        // returns true if any activation is succeed
        //###############################################################
        mngr.Evaluate = function()
        {
            clear_result();

            var activation_succeed = false;
            var license_files_list = {};
            var license_file = null;

            mngr.Log("Start activations evaluation");

            if(arguments.length && arguments[0])
                license_file = arguments[0];

            var features_info_size = 0;
            var current_progress = 0;
            for(var fs in features_info){ features_info_size++; };
            var increase_value = parseInt(100 / (features_info_size ? features_info_size : 1));
            for(var i in features_info)
            {
                current_progress += increase_value;
                if(features_info_size > 1)
                    Wizard.StatusBar.SetProgressTitle(StringList.Format("[checking_license_perc]", current_progress));
                else
                    Wizard.StatusBar.SetProgressTitle(StringList.Format("[checking_license_no_perc]"));
                var f_inf = features_info[i];

                // extracting feature_name and feature support_code (if they exists)
                var elems =  i.split("$");

                var feature = elems[0];
                var feature_support_code = elems[1];

                var r = feature_valid(feature, mngr.Chklic(), mngr.FulfillmentID(), mngr.ProductID(), license_file, feature_support_code, mngr.Platforms());

                features[i] = r.exit_code;
                Log("Feature: " + i + " >> support_code: " + r.code + " license_type: " + r.type);
                support_code = support_code | parseInt(r.code);
                if(r.type)
                    license_type = r.type;

                copy(r, f_inf);
            }

            mngr.Log("Dump features info ");
            for(var f in features)
            {
                mngr.Log(f + " val = " + features[f]);

                for(var j in features_info[f])
                   mngr.Log(f + "." + j + " = " + features_info[f][j]);

                mngr.Log("##################");
            }

            mngr.Log("Dump features info done");

            // start checking each activation
            for(var k in activation_info_list)
            {
                var info = activation_info_list[k];
                var expression = String(info.feature_name).replace(/-/g,"_HYPHEN_");

                mngr.Log("evaluation of \"" + expression + "\"" );

                var ret = 0;

                if(expression)
                {
                   with(features)
                   {
                     ret = eval(expression);
                   }
                }

                mngr.Log("evaluation of \"" + expression + "\" = " + ret);

                if(evaluate_has_trial(features_info, expression))
                {
                   info.has_trial = 1;
                   set_has_trial(1);

                   if(days_remain(features_info, expression))
                   {
                       var days = null;
                       for(var m in info.features)
                       {
                           // the remaining days is defined as the minimal value from the features which are used in expression.
                           days = (days === null) ? features_info[m].days_remaining : days;
                           if(features_info[m].days_remaining && days > features_info[m].days_remaining)
                              days = features_info[m].days_remaining;
                       }

                       set_days_remaining(days);
                       info.days_remaining = days;
                   }
                   else
                   {
                       info.days_remaining = 1;
                       set_days_remaining(1);
                   }
                }

                if(ret)
                {
                    if(regular_license_exists(features_info, expression))
                    {
                        //info.trial_only = 0;
                        set_trial_only(0);
                        for(var n in info.features)
                        {
                            if(features_info[n].file)
                                license_files_list[features_info[n].file] = features_info[n].file;
                        }
                    }
                    else
                    {
                        set_trial_only(1);
                        info.trial_only = 1;
                    }

                    activation_succeed = true;
                }
            }

            mngr.file = "";
            for(var lf in license_files_list)
            {
               mngr.file = mngr.file ? ( mngr.file + "," + lf) : lf;
            }

            if(!activation_succeed)
            {
                mngr.LastCheckResult({exit_code : false, error_message : StringList.Format("[no_valid_license_found]")});
            }
            else
            {
                mngr.LastCheckResult({exit_code : true, error_message : StringList.Format("[valid_license_found]")});
            }

            return activation_succeed;
        }
        //#######################################
        // Returns result from latest Evaluate execution (object : {exit_code : true/false, error_message : string")} )
        //#######################################
        mngr.LastCheckResult = function(val)
        {
            if(typeof(val) != "undefined")
                mngr.last_check_result = val;

            return mngr.last_check_result;
        }
        //#######################################
        mngr.CheckValidLicenseExists = function()
        {
            mngr.Log("CheckValidLicenseFileExists start");
            clear_last_result();
            if(arguments.length && arguments[0]) //silent mode
                mngr.ActivationType(mngr.activation_type_t.license_file);

            var eval_ret = mngr.Evaluate();
            var res = mngr.LastCheckResult();

            if(res)
                mngr.Log("CheckValidLicenseFileExists: completed res = " + res.exit_code);
            else
            {
                // Evaluation done but res isn't defined - smth wrong!
                mngr.Log("WARNING: CheckValidLicenseFileExist: completed evaluate returned = " + eval_ret + " but LastCheckResult is not defined!");
            }

            return res;
        }
        //#######################################
        mngr.ActivateOnline = function(sn)
        {
            mngr.Log("OnlineActivation start");
            clear_last_result();
            mngr.ActivationType(mngr.activation_type_t.serial_number);
            if (sn)
                mngr.TriedSerialNumber(sn);

            if(!activation_info_list.length)
                return {exit_code : false, error_message : "no activation info"};

            var info = "";
            mngr.FilterFeaturesInfo(function(_inf) { info = _inf;});

            var online = Activation(info.feature_name, mngr.Chklic()).Online();
            online.registration_center_url = info.registration_center_url;
            online.platforms = info.platforms;
            var check_existing_licenses = typeof(info.check_existing_licenses) != "undefined" ? true : false;

            var r = online.GetLicenseFromIrc(sn);
            if(!r)
                return {exit_code : false, error_message : online.error_message};

            var eval_ret;
            if (check_existing_licenses)
            {
                Log("Evaluate licenses using check_existing_licenses tag");
                eval_ret = mngr.Evaluate();
            }
            else
            {
                var license_file = online.GetLicenseFileName();
                eval_ret = mngr.Evaluate(license_file);
            }
            mngr.Log("OnlineActivation completed res = " + eval_ret);

            if(!eval_ret)
            {
                return { exit_code: false, error_message: StringList.Format("[IDS_INVALID_SN_FOR_PACKAGE]") }
            }

            mngr.SerialNumber(sn);
            return {exit_code : true, error_message : StringList.Format("[valid_license_found]")};
        }
        //#######################################
        mngr.ActivateLicenseFile = function(file)
        {
            mngr.Log("LicenseActivation start");
            clear_last_result();
            mngr.ActivationType(mngr.activation_type_t.license_file);

            if(!activation_info_list.length)
                return {exit_code : false, error_message : "no activation info"};

            var info = "";
            mngr.FilterFeaturesInfo(function(_inf) { info = _inf;});

            var licfile = Activation(info.feature_name, mngr.Chklic()).LicenseFile();
            mngr.Log("processing license file: " + file);
            licfile.platforms = info.platforms;
            var check_existing_licenses = typeof(info.check_existing_licenses) != "undefined" ? true : false;

            licfile.file = file;
            var r = licfile.SetLicenseFile();
            mngr.Log("processing license file. SetLicenseFile: " + r);
            if(!r)
                return {exit_code : false, error_message : licfile.error_message};

            var eval_ret;
            if (check_existing_licenses)
            {
                Log("Evaluate licenses using check_existing_licenses tag");
                eval_ret = mngr.Evaluate();
            }
            else
            {
                eval_ret = mngr.Evaluate(file);
            }
            mngr.Log("LicenseActivation completed res = " + eval_ret);

            if (!eval_ret )
            {
                return { exit_code: false, error_message: StringList.Format("[IDS_INVALID_LICENSE_FILE]") }
            }

            mngr.LicenseFile(file);

            return {exit_code : true, error_message : StringList.Format("[valid_license_found]")};
        }
        //#######################################
        mngr.ActivateTrial = function()
        {
            mngr.Log("TrialActivation start");
            clear_last_result();
            mngr.ActivationType(mngr.activation_type_t.trial);

            if(mngr.SupportType() == "BETA")
            {
                Log("Beta support code. no eval");
                return {exit_code : false, error_message : StringList.Format("[no_valid_license_found]")}
            }

            if(mngr.has_trial)
            {
                Log("Trial license exists");
                var days = mngr.days_remaining;

                if(days > 0)
                {
                    return {exit_code : true, error_message : StringList.Format("[IDS_EVAL_DAYS_REMAINING]", days)};
                }

                return {exit_code : false, error_message : StringList.Format("[IDS_EVAL_EXPIRED2]")};
            }

            var info = "";
            mngr.FilterFeaturesInfo(function(_inf) { info = _inf;});

            var trial = Activation(info.feature_name, mngr.Chklic()).Trial();

            trial.platforms = mngr.Platforms();
            trial.asr_file = mngr.ASR();
            var r = trial.LoadASRFile();

            if(!r)
                return { exit_code: false, error_message: trial.error_message };

            var eval_ret = mngr.Evaluate();

            mngr.Log("TrialActivation completed res = " + eval_ret);

            if(!eval_ret)
            {
                return {exit_code : false, error_message : StringList.Format("[no_valid_license_found]")}
            }

            return {exit_code : true, error_message : StringList.Format("[valid_license_found]")};
        }
        //#######################################
        mngr.ActivateRemote = function(sn)
        {
            mngr.Log("RemoteActivation start");
            clear_last_result();
            if (sn)
                mngr.TriedSerialNumber(sn);

            var eval_ret = mngr.Evaluate();

            mngr.Log("OfflineActivation completed res = " + eval_ret);

            if(!eval_ret)
                return {exit_code : false, error_message : StringList.Format("[no_valid_license_found]")}

            mngr.SerialNumber(sn);
            return {exit_code : true, error_message : StringList.Format("[valid_license_found]")};
        }
        //#######################################

        if(_info)
          mngr.AddInfo(_info);

        return mngr;
    }

    var manager = create_activation_manager();

    var instance = function(activation_info)
    {
        var f_info = activation_info;

        var dialogs;

        var trial_allowed = false;

        var activation_type_s = "none";
        var silent_activation_type = function(val)
        {
            if(typeof(val) != "undefined")
                activation_type_s = val;
            return activation_type_s;
        }

        var activation_type_g = "none";
        var activation_sn = "";

        var gui_activation_type = function() { return activation_type_g;}

        manager.AddInfo(activation_info);

        var activation_engine = manager;
        var check = manager;

        var activation_type_handler = function(control, action, value)
        {
            Log("Switching activation type, was: " + activation_type_g + " now: " + value);
            activation_type_g = value;
        }

        Wizard.Subscribe("activation_options_dlg", "type", activation_type_handler);
        Wizard.Subscribe("activation_options_exist_license_dlg", "type", activation_type_handler);
        Wizard.Subscribe("activation_advanced_dlg", "type", activation_type_handler);

        var configure = function(dlg)
        {
            Log("Configuration licensing start");
            dialogs = dlg;

            if(manager.SupportType() == "BETA")
            {
                Log("Beta support code. no eval");
                dlg.ActivationOpt.EnableEval(false);
            }

            var ret = check.Evaluate();

             Log("configure check.file = " + check.file);
             Log("configure check.has_trial = " + check.has_trial);
             Log("configure check.trial_only = " + check.trial_only);
             Log("configure check.days_remaining = " + check.days_remaining);

            if(ret)
            { // ok, we have at least one license...
                Log("Valid licenses found");
                if(check.has_trial)
                {
                    Log("Trial licenses exists");
                    var days = check.days_remaining;
                    if(days > 0)
                    {
                        var msg = StringList.Format("[IDS_EVAL_DAYS_REMAINING]", days);
                        if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                            Wizard.Notify("activation_options_dlg/remain_richedit", "set_blue", StringList.Format(msg));
                        else
                            Wizard.Notify("activation_options_dlg/remain_richedit", "set rtf text", StringList.Format("[blue_rtf]", msg));
                        //Wizard.Notify("activation_options_dlg/remain_static", "show");
                    }
                    else
                    {
                        if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                            Wizard.Notify("activation_options_dlg/remain_richedit", "set_red", StringList.Format("[IDS_EVAL_EXPIRED2]"));
                        else
                            Wizard.Notify("activation_options_dlg/remain_richedit", "set rtf text", StringList.Format("[red_rtf]", "[IDS_EVAL_EXPIRED2]"));
                        //Wizard.Notify("activation_options_dlg/remain_static", "show");
                        dlg.ActivationOpt.EnableEval(false);
                    }
                }

                if(check.trial_only)
                { // only trial license is available.
                    Log("Only trial license exists");
                    trial_allowed = true;
                }
                else
                { // non-trial licenses available...
                    Log("Regular & trial licenses exist");
                    trial_allowed = false;
                    Wizard.Notify("activation_options_exist_license_dlg/license_file_edit", "set text", check.file);
                }
            }
            else if(check.has_trial)
            {
                Log("configure has trial");
                //Wizard.Notify("activation_options_dlg/remain_richedit", "set rtf text", StringList.Format("[red_rtf]", "[IDS_EVAL_EXPIRED2]"));
                if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                    Wizard.Notify("activation_options_dlg/remain_richedit", "set_red", StringList.Format("[IDS_EVAL_EXPIRED2]"));
                else
                    Wizard.Notify("activation_options_dlg/remain_richedit", "set rtf text", StringList.Format("[red_rtf]", "[IDS_EVAL_EXPIRED2]"));
                //Wizard.Notify("activation_options_dlg/remain_static", "show");
                dlg.ActivationOpt.EnableEval(false);
                trial_allowed=true;
            }
            else
            {
                Log("Clean system");
                trial_allowed = true;
            }
        }

        var check_valid_license_exists = function(silent_mode)
        {
            var r = activation_engine.CheckValidLicenseExists(silent_mode);

            return {exit_code : r.exit_code, error_message : r.error_message};
        }

        var activate_sn_silent = function(sn)
        {
            var r = activation_engine.ActivateOnline(sn);

            return {exit_code : r.exit_code, error_message : r.error_message};
        }

        var activate_sn = function (sn)
        {
            var ret = activate_sn_silent(sn);

            if (!ret.exit_code)
            {
                if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                    Wizard.Notify("sn", "error", ret.error_message);
                else
                    Action.MessageBox({ title: "[ACTIVATION_ERROR_TITLE]", text: ret.error_message, icon: "error", buttons: "ok" });
                return false;
            }

            return true;
        }

        var activate_trial_silent = function ()
        {
            var r = activation_engine.ActivateTrial();

            return {exit_code : r.exit_code, error_message : r.error_message};

        }

        var activate_trial = function()
        {
            Wizard.BusyStart();

            var ret = activate_trial_silent();

            Wizard.BusyStop();

            if(!ret.exit_code)
            {
                if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                    Wizard.Notify("eval", "error", ret.error_message);
                else
                    Action.MessageBox({ title: "[ACTIVATION_ERROR_TITLE]", text: ret.error_message, icon: "error", buttons: "ok" });
                return false;
            }

            return true;
        }

        var activation_remote = function()
        {
            var offline = Activation(activation_engine.FeaturesList().join(" & "),  activation_engine.Chklic()).Offline();
            offline.unused_flex_code_names = activation_engine.UnusedFeaturesList().join(";");
            offline.media_id = activation_engine.MediaID();
            offline.map_file_dir = activation_engine.MapFileDirList()[0];

            var serial = activation_sn;

            var remote_sn_enter = function(control, action, value)
            {
                serial = value;
                if(value.length == 13)
                {
                    var request = offline.GetActivationCode(value);
                    if(request)
                    {
                        Wizard.Notify("remote_activation_dlg/activation_code_edit", "enable");
                        Wizard.Notify("remote_activation_dlg/activation_code_edit", "set text", request);
                        Wizard.Notify("remote_activation_dlg/ucn_edit", "enable");
                    }
                    else
                    {
                        Wizard.Notify("remote_activation_dlg/activation_code_edit", "disable");
                        Wizard.Notify("remote_activation_dlg/activation_code_edit", "set text", "[INVALID_SN]");
                        Wizard.Notify("remote_activation_dlg/ucn_edit", "disable");
                    }
                }
                else
                {
                    Wizard.Notify("remote_activation_dlg/activation_code_edit", "disable");
                    Wizard.Notify("remote_activation_dlg/activation_code_edit", "set text", "[INVALID_SN]");
                    Wizard.Notify("remote_activation_dlg/ucn_edit", "disable");
                }
            }

            Wizard.Subscribe("remote_activation_dlg/offline_sn_edit", "OnChanged", remote_sn_enter);
            Wizard.Notify("remote_activation_dlg/offline_sn_edit", "set text", activation_sn);
            remote_sn_enter("", "", activation_sn);

            while(true)
            {
                var res = dialogs.ActivationRemote();
                activation_sn = serial;

                if(res == Action.r_ok)
                {
                    var response = Wizard.Notify("remote_activation_dlg/ucn_edit", "get text");

                    Wizard.BusyStart();

                    Log("Start activation by unlock code");

                    offline.ActivateByUnlockCode(activation_sn, response);

                    var ret = activation_engine.ActivateRemote(activation_sn);

                    Log("End activation by unlock code");
                    Wizard.BusyStop();

                    if(!ret.exit_code)
                        Action.MessageBox({ title: "[ACTIVATION_ERROR_TITLE]", text: ret.error_message, icon: "error", buttons: "ok" });
                    else
                        return Action.r_ok;
                }
                else
                    return res;
            }
        }

        var activate_licfile_silent = function(file)
        {
            if(!file)
                return { exit_code: false, error_message: StringList.Format("[lic_file_not_defined]")};

            var r = activation_engine.ActivateLicenseFile(file);

            return {exit_code : r.exit_code, error_message : r.error_message};
        }

        var activation_licfile = function()
        {
            while(1)
            {
                var res = dialogs.ActivationLF();
                if(res == Action.r_ok)
                {
                    var file = Wizard.Notify("license_file_dlg/license_file_edit", "get text");
                    if(file)
                    {
                        Wizard.BusyStart();
                        var ret = activate_licfile_silent(file);
                        Wizard.BusyStop();

                        if(!ret.exit_code)
                            if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                                Wizard.Notify("lic_file", "error", ret.error_message);
                            else
                                Action.MessageBox({ title: "[ACTIVATION_ERROR_TITLE]", text: ret.error_message, icon: "error", buttons: "ok" });
                        else
                            return Action.r_ok;
                    }
                }
                else
                    return res;
            }
        }

        var activation_manager = function()
        {
            while(1)
            {
                var res = dialogs.ActivationLM();
                if(res == Action.r_ok)
                {
                    var host = Wizard.Notify("license_manager_dlg/hostname_edit", "get text");
                    var port = Wizard.Notify("license_manager_dlg/port_edit", "get text");
                    if(port && host)
                    {
                        var file = port + "@" + host;

                        Wizard.BusyStart();
                        Wizard.Notify("lic_manager", "start");
                        var ret = activate_licfile_silent(file);
                        Wizard.Notify("lic_manager", "stop");
                        Wizard.BusyStop();

                        if(!ret.exit_code)
                            if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                                Wizard.Notify("lic_manager", "error", ret.error_message);
                            else
                                Action.MessageBox({title: "[ACTIVATION_ERROR_TITLE]" , text: ret.error_message, icon: "error", buttons: "ok"});
                        else
                            return Action.r_ok;
                    }
                }
                else
                    return res;
            }

        }

        var activation_advanced = function()
        {
            activation_remote.Skip = function(){return true;}
            activation_licfile.Skip = function(){return true;}
            activation_manager.Skip = function(){return true;}

            while(1)
            {
                var res = dialogs.ActivationAdvanced();
                switch(res)
                {
                case Action.r_ok:
                    if(activation_type_g == "lic_file")
                    {
                        //activation_licfile.Skip = function(){return false;}
                        var file = Wizard.Notify("activation_advanced_dlg/license_file_edit", "get text");
                        if(file)
                        {
                            Wizard.BusyStart();
                            Wizard.Notify("lic_file", "start");
                            var ret = activate_licfile_silent(file);
                            Wizard.Notify("lic_file", "stop");
                            Wizard.BusyStop();

                            if(!ret.exit_code)
                            {
                                if(typeof(WPF) != "undefined" && GetOpt.Exists("wpf"))
                                    Wizard.Notify("lic_file", "error", ret.error_message);
                                else
                                    Action.MessageBox({ title: "[ACTIVATION_ERROR_TITLE]", text: ret.error_message, icon: "error", buttons: "ok" });
                                continue;
                            }
                            else
                                return Action.r_ok;
                        }
                        else
                            continue;
                    }
                    else if(activation_type_g == "lic_manager")
                    {
                        activation_manager.Skip = function(){return false;}
                        return res;
                    }
                    break;
                default:
                    break;
                }
                return res;
            }
        }

        var activation_options = function()
        {
            activation_advanced.Skip = function(){return true;}
            var ok = false;
            do
            {
                var res;
                if(trial_allowed)
                {
                    res = dialogs.ActivationOpt();
                    activation_sn = Wizard.Notify("activation_options_dlg/sn_edit", "get text");
                }
                else
                {
                    res = dialogs.ActivationOptExistLicense();
                    activation_sn = Wizard.Notify("activation_options_exist_license_dlg/sn_edit", "get text");
                }

                Log("Activation type: " + activation_type_g);

                switch(res)
                {
                case Action.r_ok:
                    if(activation_type_g == "sn")
                    {
                        Log("Processing serial number based activation: " + activation_sn);
                        Wizard.BusyStart();
                        Wizard.Notify("sn", "start");
                        ok = activate_sn(activation_sn);
                        Wizard.Notify("sn", "stop");
                        Wizard.BusyStop();
                        break;
                    }
                    else if(activation_type_g == "use_existent")
                    {
                        Log("Using existing license file");
                        return Action.r_ok;
                    }
                    else if(activation_type_g == "advanced")
                    {
                        Log("Using advanced activation");
                        activation_advanced.Skip = function(){return false;}
                        return Action.r_ok;
                    }
                    else if(activation_type_g == "eval")
                    {
                        Log("Processing trial activation");
                        Wizard.BusyStart();
                        Wizard.Notify("eval", "start");
                        ok = activate_trial();
                        Wizard.Notify("eval", "stop");
                        Wizard.BusyStop();
                        break;
                    }
                    return res;
                default:
                    return res;
                }
            } while(!ok);
            return Action.r_ok;
        }

        var schedule = function(scenario)
        {
            // ##### add all activation dialogs by default ###################
            scenario.Add(activation_options);
            scenario.Add(activation_advanced);
            scenario.Add(activation_remote);
            scenario.Add(activation_licfile);
            scenario.Add(activation_manager);

            activation_options.Skip = function(){return false;}
            activation_advanced.Skip = function(){return true;}
            activation_remote.Skip = function(){return true;}
            activation_licfile.Skip = function(){return true;}
            activation_manager.Skip = function(){return true;}
            // ###############################################################
        }

        var scenario = function()
        {
            var sc = required(Origin.Directory() + "scenario3.js").Create();
            if(sc)
            {
                sc.Add(activation_options);
                sc.Add(activation_advanced);
                sc.Add(activation_remote);
                sc.Add(activation_licfile);
                sc.Add(activation_manager);

                activation_options.Skip = function(){return false;}
                activation_advanced.Skip = function(){return true;}
                activation_remote.Skip = function(){return true;}
                activation_licfile.Skip = function(){return true;}
                activation_manager.Skip = function(){return true;}

                return sc;
            }

            return null;
        }

        return {Manager: manager,
                EvaluateFeaturesExpression: manager.EvaluateFeaturesExpression,
                SerialNumber : manager.SerialNumber,
                configure: configure,
                schedule: schedule,
                scenario: scenario,
                activation_info: f_info,
                check_valid_license_exists : check_valid_license_exists,
                last_check_result : manager.LastCheckResult,
                activate_sn : activate_sn_silent,
                activate_trial : activate_trial_silent,
                activate_licfile : activate_licfile_silent,
                add_info : manager.AddInfo,
                gui_activation_type : gui_activation_type,
                silent_activation_type : silent_activation_type,
                TriedSerialNumber : manager.TriedSerialNumber
                };
    }

    // Return License instance
    return {
        // Get the Singleton instance if one exists or create one if it doesn't
        getInstance: instance,
        //feature_valid: feature_valid
        EvaluateFeaturesExpression : manager.EvaluateFeaturesExpression
        }
};

//###############################################################



/** @fn Activation(string feature, string chklic_path)
 *  @brief Creates Activation object with pre-defined attributes
 *  @param string feature feature list
 *  @param string chklic_path path to chklic module
 */

/** @class Activation
 *  @brief Constructor for product activation and evaluation objects
 *  @details During installation some licensing info should be delivered to target system
 *    and evaluate for existing license files.
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Evaluate LicenseFile Trial Offline Online
 */

/** @method Activation Online
 *  @brief Create Online activation object
 *  @usage
 *    var online = Activation.Online();
 *  @see Online
 */

/** @method Activation Offline
 *  @brief Create Offline activation object
 *  @usage
 *    var offline = Activation.Offline();
 *  @see Offline
 */

/** @method Activation Trial
 *  @brief Create Trial activation object
 *  @usage
 *    var trial = Activation.Trial();
 *  @see Trial
 */

/** @method Activation LicenseFile
 *  @brief Create LicenseFile activation object
 *  @usage
 *    var lic_file = Activation.LicenseFile();
 *  @see LicenseFile
 */

/** @method Activation Check
 *  @brief Create licenses evaluation object
 *  @usage
 *    var eval = Activation.Evaluate();
 *  @see Check
 */


/** @class Online
 *  @brief Online object provides ability to deliver license file from IRC by Serial Number
 *  @details Online object provides ability to deliver license file from IRC by Serial Number
 *  @attr string feature_name read/write, feature specification string
 *  @attr string chklic read/write, path to chklic.exe module
 *  @attr string registration_center_url read/write property to specify IRC registration url
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Evaluate LicenseFile Trial Offline Activation
 */

/** @method Online GetLicenseFromIrc(string sn)
 *  @brief Get license file from IRC
 *  @param string sn serial number to process
 *  @return boolean
 *    - true on success
 *    - false on failure
 *  @usage
 *    var online = Activation.Online();
 *    online.registration_center_url = "http://intel.com";
 *    if(online.GetLicenseFromIrc("1234-567890"))
 *    {
 *        // ok, license is delivered
 *    }
 *  @see Write
 */

/** @method Online IsIrcReachable
 *  @brief Check if IRC available
 *  @return boolean
 *    - true IRC is available
 *    - false IRC is not available
 *  @usage
 *    var online = Activation.Online();
 *    online.registration_center_url = "http://intel.com";
 *    if(online.IsIrcReachable())
 *    {
 *        // ok, IRC is available
 *    }
 *  @see Write
 */


/** @class Offline
 *  @brief Offline object provides ability to activate product by activation code
 *  @details Offline object provides ability to activate product by activation code
 *  @attr string feature_name read/write, feature specification string
 *  @attr string chklic read/write, path to chklic.exe module
 *  @attr string unused_flex_code_names read/write, unused features enumeration
 *  @attr string media_id read/write, media id string
 *  @attr string map_file_dir read/write, path to map file
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Evaluate LicenseFile Trial Online Activation
 */

/** @method Offline GetActivationCode(string sn)
 *  @brief Get activation code to pass it to IRC
 *  @param string sn serial number to process
 *  @return string activation code to pass to IRC or null on failure
 *  @note Prior to call this function properties feature_name, unused_flex_code_names,
 *    media_id and map_file_dir must be initialized
 *  @usage
 *    var offline = Activation.Offline();
 *    offline.feature_name = "feature";
 *    offline.unused_flex_code_names = "unused_feature";
 *    offline.media_id = "my_media_id";
 *    offline.map_file_dir = "c:\\program files\\map_file.txt";
 *    online.registration_center_url = "http://intel.com";
 *    var code = offline.GetActivationCode("1234-567890");
 *    if(code)
 *    {
 *        // ok, code is generated
 *    }
 *  @see Write
 */

/** @method Offline ActivateByUnlockCode(string sn, string unlock_code)
 *  @brief Extract license from map file by unlock code
 *  @param string sn serial number to process
 *  @param string unlock_code unlock code provided by IRC
 *  @return boolean
 *    - true on success
 *    - false on failure
 *  @note Prior to call this function properties feature_name, unused_flex_code_names,
 *    media_id and map_file_dir must be initialized
 *  @usage
 *    var offline = Activation.Offline();
 *    offline.feature_name = "feature";
 *    offline.unused_flex_code_names = "unused_feature";
 *    offline.media_id = "my_media_id";
 *    offline.map_file_dir = "c:\\program files\\map_file.txt";
 *    online.registration_center_url = "http://intel.com";
 *    var code = offline.GetActivationCode("1234-567890");
 *    if(code)
 *    {
 *        // ok, code is generated, pass it to IRC
 *        if(offline.ActivateByUnlockCode("1234-567890", returned_from_irc_code))
 *        {
 *            // activated
 *        }
 *    }
 *  @see Write
 */


/** @class Trial
 *  @brief Activate trial license
 *  @details Trial object provides ability to activate trial period of product usage
 *  @attr string asr_file read/write, path to asr file to embed into trusted storage
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Evaluate LicenseFile Online Offline Activation
 */

/** @method Trial LoadASRFile
 *  @brief Embed asr file into trusted storage
 *  @return boolean
 *    - true on success
 *    - false on failure
 *  @note Prior to call this function property asr_file must be initialized
 *  @usage
 *    var trial = Activation.Trial();
 *    trial.asr_file = "c:\\program files\\asr_file.txt";
 *    if(offline.LoadASRFile())
 *    {
 *        // ok, trial period started
 *    }
 *  @see Write
 */

/** @class LicenseFile
 *  @brief Activate product by license file or license server
 *  @details LicenseFile object provides ability to activate product by license file or license server
 *  @attr string feature_name read/write, feature specification string
 *  @attr string chklic read/write, path to chklic.exe module
 *  @attr string file read/write, path to license file or remote license server specification string
 *    in format <code>port\@host</code>
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Evaluate Online Trial Offline Activation
 */

/** @method LicenseFile SetLicenseFile
 *  @brief Process license file
 *  @return boolean
 *    - true on success
 *    - false on failure
 *  @note Prior to call this function properties chklic and file must be initialized
 *  @usage
 *    var lic_file = Activation.LicenseFile();
 *    lic_file.file = "c:\\program files\\license.lic";
 *    lic_file.chklic = "c:\\program files\\chklic.exe";
 *    if(lic_file.SetLicenseFile())
 *    {
 *        // ok, license file processed
 *    }
 */


/** @class Check
 *  @brief Check of feature list on existing licenses (regular or evaluation)
 *  @details LicenseFile object provides ability to activate product by license file or license server
 *  @attr string feature_name read/write, feature specification string
 *  @attr string chklic read/write, path to chklic.exe module
 *  @attr string fulfillment_id read/write, fulfillment_id specification string, used for evaluation of
 *    trial licenses
 *  @attr string product_id read/write, product_id specification string, used for evaluation of
 *  @attr boolean trial_only readonly, true if detected only trial licenses for specified features,
 *    available only after Evaluate method called
 *  @attr boolean has_trial readonly, true if detected at least one trial license for specified features,
 *    available only after Evaluate method called
 *  @attr number days_remaining readonly, number of days to trial expiration,
 *    available only after Evaluate method called
 *  @attr number type readonly, license type,
 *    available only after Evaluate method called
 *  @attr number code readonly, license support code,
 *    available only after Evaluate method called
 *  @attr string file readonly, license file found for specified feature set,
 *    available only after Evaluate method called
 *
 *  @attr number error_code readonly, last operation error code
 *  @attr string error_message readonly, last operation error message
 *  @see Online LicenseFile Trial Offline Activation
 */

/** @method Evaluate Evaluate
 *  @brief Evaluate available licenses for specified features
 *  @return boolean
 *    - true on success
 *    - false on failure
 *  @note Prior to call this function at least properties chklic and feature_name must be initialized
 *  @usage
 *    var eval = Activation.Evaluate();
 *    eval.chklic = "c:\\program files\\chklic.exe";
 *    eval.feature_name = "feature1 & feature2";
 *    if(eval.Evaluate())
 *    {
 *        // ok, found valid licenses
 *    }
 */
